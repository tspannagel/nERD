import * as vscode from 'vscode';
import { ErdPanel } from './panel';

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(
    vscode.commands.registerCommand('nerd.openErd', async (uri?: vscode.Uri) => {
      const target = uri?.fsPath.toLowerCase().endsWith('.sqlproj') ? uri : await pickProject();
      if (target) ErdPanel.show(ctx, target);
    }),
    vscode.commands.registerCommand('nerd.refresh', () => ErdPanel.active?.refresh()),
  );
}

export function deactivate() {}

async function pickProject(): Promise<vscode.Uri | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.fsPath.toLowerCase().endsWith('.sqlproj')) return active;
  const found = await vscode.workspace.findFiles('**/*.sqlproj', '**/{bin,obj,node_modules}/**');
  if (found.length === 0) {
    const pick = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'SQL Database Project': ['sqlproj'] },
      openLabel: 'Open ERD',
    });
    return pick?.[0];
  }
  if (found.length === 1) return found[0];
  const item = await vscode.window.showQuickPick(
    found.map((u) => ({ label: vscode.workspace.asRelativePath(u), uri: u })),
    { placeHolder: 'Select a SQL database project' },
  );
  return item?.uri;
}
