import * as path from 'path'
import * as fs from 'fs'
import * as vscode from 'vscode'

let hoverProvider: vscode.HoverProvider & { addHover: (...args: any) => void; reset: (...args: any) => void }
let linkProvider: vscode.DocumentLinkProvider & { addLink: (...args: any) => void; reset: (...args: any) => void }
let hoverDisposable: vscode.Disposable | undefined
let linkDisposable: vscode.Disposable | undefined
let activeEditor = vscode.window.activeTextEditor

export function activate(context: vscode.ExtensionContext) {
  const { activeChange } = getOptions()

  hoverProvider = new ImportHoverProvider()
  linkProvider = new ImportLinkProvider()

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      activeEditor = editor
      if (activeEditor)
        updateProviders()
    }, null, context.subscriptions),
  )

  if (activeChange) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (activeEditor && event.document === activeEditor.document)
          updateProviders()
      }, null, context.subscriptions),
    )
  }

  updateProviders()

  // 在插件激活时显示成功信息
  // vscode.window.showInformationMessage('插件已成功激活！')
}

function getOptions() {
  vscode.window.showInformationMessage('activeChange')

  const activeChange: boolean = vscode.workspace.getConfiguration('js-goto-definition-alias').get('activeChange') || false!
  const tsconfigPath: string = vscode.workspace.getConfiguration('js-goto-definition-alias').get('tsconfigPaths') || 'undefined'

  // const alias: Record<string, any> = vscode.workspace.getConfiguration().get('alias')!

  return {
    activeChange,
    tsconfigPath,
    // alias,
  }
}

function provideGoToPath(document: vscode.TextDocument) {
  if (document.languageId !== 'javascript')
    return

  let tsConfigContent: string
  const { tsconfigPath: tsPath } = getOptions()
  const tsConfigPath = path.join(vscode.workspace.rootPath || '', 'tsconfig.json')
  const _tsPath = path.join(vscode.workspace.rootPath || '', tsPath)

  if (!fs.existsSync(tsConfigPath) && !fs.existsSync(_tsPath)) {
    vscode.window.showErrorMessage(`不能识别到tsconfig的路径: ${_tsPath}`)
    return
  }

  if (fs.existsSync(_tsPath))
    tsConfigContent = fs.readFileSync(_tsPath, 'utf8')
  else
    tsConfigContent = fs.readFileSync(tsConfigPath, 'utf8')

  // 注释清理
  tsConfigContent = tsConfigContent.split('\n').filter(i => !/\/\//.test(i) && !/\*\//.test(i)).filter(i => i).join('\n')

  const tsConfig = JSON.parse(tsConfigContent)

  if (!tsConfig.compilerOptions || !tsConfig.compilerOptions.paths)
    return

  const importRanges = document.getText().split('\n')

  linkProvider.reset()
  hoverProvider.reset()

  for (const range of importRanges) {
    const match = getMatchImport(range)
    if (!match)
      continue

    const importStatement = match[0]
    const importPath = match[1]
    let pattern = ''

    if (importPath.startsWith('.'))
      continue

    const alias = Object.keys(tsConfig.compilerOptions.paths).find((alias) => {
      pattern = alias.replace('/*', '')
      return importPath.startsWith(pattern)
    })

    if (alias) {
      const aliasPath = tsConfig.compilerOptions.paths[alias][0].replace('/*', '')
      const resolvedPath = resolveImportPath(document, importPath.replace(pattern, aliasPath).replace(/^\//, ''))
      const hoverMessage = [
        { language: 'plaintext', value: `Alias: ${alias}\nPath: "${resolvedPath}"` },
        '---',
      ]
      const hoverRange = document.getText().indexOf(importStatement)
      const hoverRangeStart = document.positionAt(hoverRange)
      const hoverRangeEnd = document.positionAt(hoverRange + importStatement.length)
      const hoverRangeObj = new vscode.Range(hoverRangeStart, hoverRangeEnd)
      const linkRange = document.getText().indexOf(importPath)
      const linkRangeStart = document.positionAt(linkRange)
      const linkRangeEnd = document.positionAt(linkRange + importPath.length)
      const linkRangeObj = new vscode.Range(linkRangeStart, linkRangeEnd)

      hoverProvider.addHover(hoverMessage, hoverRangeObj)

      const targetUri = vscode.Uri.file(resolvedPath)
      const link = new vscode.DocumentLink(linkRangeObj, targetUri)

      linkProvider.addLink(link)
    }
  }
}

function updateProviders() {
  disposeProviders()
  if (activeEditor) {
    const document = activeEditor.document
    hoverDisposable = vscode.languages.registerHoverProvider({ scheme: 'file', language: 'javascript' }, hoverProvider)
    linkDisposable = vscode.languages.registerDocumentLinkProvider({ scheme: 'file', language: 'javascript' }, linkProvider)
    provideGoToPath(document)
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
}

function resolveImportPath(document: vscode.TextDocument, importPath: string): string {
  // 在这里根据路径别名的配置解析 importPath，得到对应的文件路径
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
  if (workspaceFolder) {
    const absolutePath = vscode.Uri.joinPath(workspaceFolder.uri, importPath).fsPath

    const ext = ['.js', '.ts', '.vue']
    for (const i of ext) {
      const path = `${absolutePath}${i}`
      const _indexPath = `${absolutePath}/index${i}`
      if (fs.existsSync(path))
        return path
      if (fs.existsSync(_indexPath))
        return path
    }
    return absolutePath
  }

  return ''
}

function getMatchImport(str: string) {
  const requireRegex = /require\(['"](.+)['"]\)/
  const requireRegex2 = /.* = require\(['"](.+)['"]\)/
  const importRegex = /import .+ from ['"](.+)['"]/
  const importRegex2 = /import\(['"](.+)['"]\)/

  if (requireRegex.test(str))
    return str.match(requireRegex)
  if (requireRegex2.test(str))
    return str.match(requireRegex2)
  if (importRegex.test(str))
    return str.match(importRegex)
  if (importRegex2.test(str))
    return str.match(importRegex2)
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
