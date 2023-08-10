import * as path from 'path'
import * as fs from 'fs'
import * as vscode from 'vscode'
import os from 'os'

const isWin = os.platform() === 'win32'

let hoverProvider: vscode.HoverProvider & { addHover: (...args: any) => void; reset: (...args: any) => void }
let linkProvider: vscode.DocumentLinkProvider & { addLink: (...args: any) => void; reset: (...args: any) => void }
let hoverDisposable: vscode.Disposable | undefined
let linkDisposable: vscode.Disposable | undefined
let activeCHangeDisposable: vscode.Disposable | undefined
let activeEditor = vscode.window.activeTextEditor

export function activate(context: vscode.ExtensionContext) {
  hoverProvider = new ImportHoverProvider()
  linkProvider = new ImportLinkProvider()

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      activeEditor = editor
      if (activeEditor)
        provideGoToPath(activeEditor.document)
    }, null, context.subscriptions),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('js-goto-definition-alias')) {
        disposeProviders()
        updateProviders(context)
      }
    }),
  )

  updateProviders(context)
  provideGoToPath(activeEditor?.document || {} as vscode.TextDocument)
}

function getOptions() {
  const { activeChange = false, tsconfigPath = null, runner = [] } = vscode.workspace.getConfiguration('js-goto-definition-alias')

  // const alias: Record<string, any> = vscode.workspace.getConfiguration().get('alias')!

  return {
    activeChange,
    tsconfigPath,
    runner: ['javascript', ...runner],
    // alias,
  }
}

function provideGoToPath(document: vscode.TextDocument) {
  let tsConfigContent: string
  const { tsconfigPath: tsPath, runner } = getOptions()
  if (!runner.includes(document.languageId))
    return

  const tsConfigPath = path.join(vscode.workspace.rootPath || '', 'tsconfig.json')
  const _tsPath = (tsPath && path.join(vscode.workspace.rootPath || '', tsPath)) || ''
  const activePath = document.uri.fsPath
  const _transformPath = activePath?.replace(/(packages[\\/]\w+[\\/]).*/, '$1') || ''
  const transformPath = path.join(_transformPath, 'tsconfig.json')

  if (!fs.existsSync(tsConfigPath) && !fs.existsSync(_tsPath) && !fs.existsSync(transformPath)) {
    console.error(`不能识别到tsconfig的路径: ${_tsPath}`)
    return
  }

  if (fs.existsSync(_tsPath))
    tsConfigContent = fs.readFileSync(_tsPath, 'utf8')
  else if (fs.existsSync(tsConfigPath))
    tsConfigContent = fs.readFileSync(tsConfigPath, 'utf8')
  else
    tsConfigContent = fs.readFileSync(transformPath, 'utf8')

  // 注释清理
  tsConfigContent = tsConfigContent.split('\n').filter(i => !/\/\//.test(i) && !/\*\//.test(i)).filter(i => i).join('\n')

  const tsConfig = JSON.parse(tsConfigContent)

  if (!tsConfig.compilerOptions || !tsConfig.compilerOptions.paths)
    return

 const text = document.getText()

  linkProvider.reset()
  hoverProvider.reset()

  const importRanges = getMatchImport(text)!

  for (const data of importRanges) {
    const importPath = data[1].replace(/.*?\*\/\s?['"]/, '')
    let pattern = ''

    if (importPath.startsWith('.'))
      continue

    const alias = Object.keys(tsConfig.compilerOptions.paths).find((alias) => {
      pattern = alias.replace('/*', '')
      return importPath.startsWith(pattern)
    })

    if (alias) {
      const aliasPath = tsConfig.compilerOptions.paths[alias][0].replace('/*', '')
      const resolvedPath = resolveImportPath(document, importPath.replace(pattern, aliasPath).replace(/^\//, ''), _transformPath)
      const hoverMessage = [
        { language: 'plaintext', value: `Alias: ${alias}\nPath: "${resolvedPath}"` },
        '---',
      ]

      let linkRange
      const linkReg = new RegExp(importPath, 'g')

      while (linkRange = linkReg.exec(text)) {
        const linkRangeStart = document.positionAt(linkRange.index)
        const linkRangeEnd = document.positionAt(linkRange.index + importPath.length)
        const linkRangeObj = new vscode.Range(linkRangeStart, linkRangeEnd)
        const targetUri = vscode.Uri.file(resolvedPath)
        const link = new vscode.DocumentLink(linkRangeObj, targetUri)

        hoverProvider.addHover(hoverMessage, linkRangeObj)
        linkProvider.addLink(link)
      }
    }
  }
}

function updateProviders(context: vscode.ExtensionContext) {
  const { runner, activeChange } = getOptions()
  if (activeEditor && runner.includes(activeEditor.document.languageId)) {
    const document = activeEditor.document
    hoverDisposable = vscode.languages.registerHoverProvider(runner.map(i => ({ scheme: 'file', language: i })), hoverProvider)
    linkDisposable = vscode.languages.registerDocumentLinkProvider(runner.map(i => ({ scheme: 'file', language: i })), linkProvider)

    if (activeChange) {
      activeCHangeDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
        if (activeEditor && event.document === activeEditor.document)
          provideGoToPath(document)
      }, null, context.subscriptions)
    }
  }
}

function disposeProviders() {
  if (hoverDisposable) {
    hoverDisposable.dispose()
    hoverDisposable = undefined
  }
  if (linkDisposable) {
    linkDisposable.dispose()
    linkDisposable = undefined
  }
  if (activeCHangeDisposable) {
    activeCHangeDisposable.dispose()
    linkDisposable = undefined
  }
}

function resolveImportPath(document: vscode.TextDocument, importPath: string, activePath = ''): string {
  // 在这里根据路径别名的配置解析 importPath，得到对应的文件路径
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (workspaceFolder) {
    const absolutePath = vscode.Uri.joinPath(workspaceFolder.uri, importPath).fsPath
    const _path = setExtPath(absolutePath)
    const transformPath = setExtPath(path.join(activePath, importPath))
    
    if (fs.existsSync(_path)) {
      return _path
    }
    if (fs.existsSync(transformPath)) {
      return transformPath
    }
  }

  return ''
}

function setExtPath(url: string) {
  const ext = ['.vue', '.js', '.ts']

  for (const item of ext) {
    const extPath = `${url}${item}`
    const extIndexPath = `${url}${isWin ? '\\' : '/'}index${item}`

    if (fs.existsSync(extPath))
      return extPath
    if (fs.existsSync(extIndexPath))
      return extIndexPath
  }
  return url
}

function getMatchImport(str: string, line = false) {
  const requireRegex = /require\(['"](.+)['"]\)/
  const requireRegex2 = /.*? (.+) = require\(['"](.+)['"]\)/
  const importRegex = /import {?\s*(.+?)\s*}? from ['"](.+)['"]/
  const importRegexAll = /import {?\s*([\w\W]+?)\s*}? from ['"](.+)['"]/g
  const importRegex2 = /import\(.*?['"](.+)['"]\)/

  const all = [
    importRegex2,
    /import\s*?['"](.+)['"]/,
    requireRegex2,
    requireRegex,
  ]

  if (requireRegex2.test(str) && line) {
    const match = str.match(requireRegex2) ?? []
    return [match[1].trim() ?? '', match[2] ?? '']
  }
  if (importRegex.test(str) && line) {
    const match = str.match(importRegex) ?? []
    return [match[1].trim() ?? '', match[2] ?? '']
  }
  if (requireRegex.test(str) && line) {
    const match = str.match(requireRegex) ?? []
    return [match[1].trim() ?? '', match[2] ?? '']
  }
  if (importRegex2.test(str) && line) {
    const match = str.match(importRegex2) ?? []
    return [match[1].trim() ?? '', match[2] ?? '']
  }

  const matchAll = str.match(importRegexAll) ?? []
  const result: any[] = []

  for (const item of matchAll)
    result.push(matchImport(item))

  for (const regItem of all) {
    const matchAll = str.match(new RegExp(regItem, 'g')) ?? []

    for (const item of matchAll)
      result.push(matchImport(item, new RegExp(regItem)))
  }

  return result.length ? result : ['', '']

  function matchImport(itemImport: string, reg = /import {?\s*([\w\W]+?)\s*}? from ['"](.+)['"]/) {
    const importRegex = reg
    const match = itemImport.match(importRegex) ?? []
    if (!match[2] && match[1])
      return [match[1] ?? '', match[1] ?? '']

    return [match[1] ?? '', match[2] ?? '']
  }
}

class ImportHoverProvider implements vscode.HoverProvider {
  private hovers: Map<vscode.Range, string> = new Map<vscode.Range, string>()

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    for (const [range, message] of this.hovers) {
      if (range.contains(position))
        return new vscode.Hover(message, range)
    }
    return null
  }

  addHover(message: string, range: vscode.Range) {
    this.hovers.set(range, message)
  }

  reset() {
    this.hovers.clear()
  }
}

class ImportLinkProvider implements vscode.DocumentLinkProvider {
  private links: vscode.DocumentLink[] = []

  provideDocumentLinks(): vscode.ProviderResult<vscode.DocumentLink[]> {
    return this.links
  }

  addLink(link: vscode.DocumentLink) {
    this.links.push(link)
  }

  reset() {
    this.links = []
  }
}

export function deactivate() {}
