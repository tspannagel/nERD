import * as path from 'path';
import * as vscode from 'vscode';
import { SchemaModel } from './model';
import { loadProject } from './parser';

type FromWebview =
  | { type: 'ready' }
  | { type: 'open'; file: string; line: number }
  | { type: 'saveLayout'; layout: unknown }
  | { type: 'exportSvg'; svg: string }
  | { type: 'refresh' };

/** One webview panel per .sqlproj; reloads when project scripts change. */
export class ErdPanel {
  private static panels = new Map<string, ErdPanel>();
  static active: ErdPanel | undefined;

  private disposables: vscode.Disposable[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;

  static show(ctx: vscode.ExtensionContext, project: vscode.Uri) {
    const key = project.fsPath;
    const existing = ErdPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'nerd.erd',
      `ERD: ${path.basename(key, '.sqlproj')}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
      },
    );
    ErdPanel.panels.set(key, new ErdPanel(ctx, panel, project));
  }

  private constructor(
    private ctx: vscode.ExtensionContext,
    private panel: vscode.WebviewPanel,
    private project: vscode.Uri,
  ) {
    ErdPanel.active = this;
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) ErdPanel.active = this; }, null, this.disposables);
    panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m), null, this.disposables);

    const dir = path.dirname(project.fsPath);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '**/*.{sql,sqlproj}'));
    const schedule = () => this.scheduleRefresh();
    watcher.onDidChange(schedule, null, this.disposables);
    watcher.onDidCreate(schedule, null, this.disposables);
    watcher.onDidDelete(schedule, null, this.disposables);
    this.disposables.push(watcher);
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('nerd')) this.refresh(); }, null, this.disposables);
  }

  private get layoutKey() { return `nerd.layout:${this.project.fsPath}`; }

  private onMessage(m: FromWebview) {
    switch (m.type) {
      case 'ready':
      case 'refresh':
        this.refresh();
        break;
      case 'open':
        void this.openSource(m.file, m.line);
        break;
      case 'saveLayout':
        void this.ctx.workspaceState.update(this.layoutKey, m.layout);
        break;
      case 'exportSvg':
        void this.exportSvg(m.svg);
        break;
    }
  }

  private scheduleRefresh() {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.refresh(), 300);
  }

  refresh() {
    const cfg = vscode.workspace.getConfiguration('nerd');
    let model: SchemaModel;
    try {
      model = loadProject(this.project.fsPath, cfg.get('defaultSchema', 'dbo'));
    } catch (e) {
      void vscode.window.showErrorMessage(`nERD: could not read ${this.project.fsPath}: ${(e as Error).message}`);
      return;
    }
    void this.panel.webview.postMessage({
      type: 'model',
      model,
      layout: this.ctx.workspaceState.get(this.layoutKey),
      options: {
        direction: cfg.get('layout.direction', 'RIGHT'),
        startCollapsed: cfg.get('startCollapsed', false),
      },
    });
  }

  private async openSource(file: string, line: number) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const pos = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      selection: new vscode.Range(pos, pos),
      preserveFocus: false,
    });
  }

  private async exportSvg(svg: string) {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(this.project.fsPath.replace(/\.sqlproj$/i, '.erd.svg')),
      filters: { SVG: ['svg'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(svg, 'utf8'));
    void vscode.window.showInformationMessage(`nERD: exported ${vscode.workspace.asRelativePath(uri)}`);
  }

  private html(): string {
    const w = this.panel.webview;
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>nERD</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose() {
    ErdPanel.panels.delete(this.project.fsPath);
    if (ErdPanel.active === this) ErdPanel.active = undefined;
    clearTimeout(this.reloadTimer);
    this.disposables.forEach((d) => d.dispose());
  }
}
