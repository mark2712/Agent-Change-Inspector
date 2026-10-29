import * as vscode from 'vscode';
import { FileChangeInfo } from './types';

/**
 * Менеджер мягкой подсветки измененных строк и маркеров на полях (Gutter)
 */
export class DecorationManager implements vscode.Disposable {
  private addedLinesType: vscode.TextEditorDecorationType;
  private deletedLineType: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];
  private isEnabled = true;

  constructor(
    private readonly getChangeInfo: (uri: vscode.Uri) => FileChangeInfo | undefined
  ) {
    // Подсветка добавленных/измененных строк (мягкий зеленый фон + полоса на скроллбаре)
    this.addedLinesType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    // Маркер удаленных строк (красная метка на скроллбаре)
    this.deletedLineType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      border: '1px dashed rgba(248, 81, 73, 0.45)',
    });

    this.disposables.push(this.addedLinesType, this.deletedLineType);

    // Слушаем смену активного редактора
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.decorateEditor(editor);
        }
      })
    );

    // Слушаем редактирование документа
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const active = vscode.window.activeTextEditor;
        if (active && active.document === e.document) {
          this.decorateEditor(active);
        }
      })
    );

    // Подсвечиваем текущий активный редактор при запуске
    if (vscode.window.activeTextEditor) {
      this.decorateEditor(vscode.window.activeTextEditor);
    }
  }

  setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    this.refreshAllVisibleEditors();
  }

  toggle(): boolean {
    this.isEnabled = !this.isEnabled;
    this.refreshAllVisibleEditors();
    return this.isEnabled;
  }

  refreshAllVisibleEditors() {
    for (const editor of vscode.window.visibleTextEditors) {
      this.decorateEditor(editor);
    }
  }

  decorateEditor(editor: vscode.TextEditor) {
    if (!this.isEnabled) {
      editor.setDecorations(this.addedLinesType, []);
      editor.setDecorations(this.deletedLineType, []);
      return;
    }

    const uri = editor.document.uri;
    const change = this.getChangeInfo(uri);

    if (!change || !change.hunks || change.hunks.length === 0 || change.isDeleted) {
      editor.setDecorations(this.addedLinesType, []);
      editor.setDecorations(this.deletedLineType, []);
      return;
    }

    const addedRanges: vscode.Range[] = [];
    const deletedRanges: vscode.Range[] = [];
    const maxLine = editor.document.lineCount - 1;

    for (const hunk of change.hunks) {
      const start = Math.max(0, Math.min(maxLine, hunk.startLine - 1));
      const end = Math.max(0, Math.min(maxLine, hunk.endLine - 1));

      if (hunk.isAddition) {
        addedRanges.push(new vscode.Range(start, 0, end, 0));
      } else {
        deletedRanges.push(new vscode.Range(start, 0, start, 0));
      }
    }

    editor.setDecorations(this.addedLinesType, addedRanges);
    editor.setDecorations(this.deletedLineType, deletedRanges);
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
