import * as vscode from 'vscode';
import * as path from 'path';
import { FileChangeInfo } from './types';

/**
 * Менеджер подсветки измененных строк, полосок на полях (Gutter) и маркеров на миникарте/скроллбаре
 */
export class DecorationManager implements vscode.Disposable {
  private addedLinesType: vscode.TextEditorDecorationType;
  private deletedLineType: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];
  private isEnabled = true;

  constructor(
    extensionUri: vscode.Uri,
    private readonly getChangeInfo: (uri: vscode.Uri) => FileChangeInfo | undefined
  ) {
    const addedGutterUri = vscode.Uri.joinPath(extensionUri, 'resources', 'gutter-added.svg');
    const deletedGutterUri = vscode.Uri.joinPath(extensionUri, 'resources', 'gutter-deleted.svg');

    // Подсветка добавленных/измененных строк:
    // - Четкая зеленая полоска в gutter (рядом с номерами строк)
    // - Мягкий полупрозрачный фон строки
    // - Маркер на полосе прокрутки (Overview Ruler)
    this.addedLinesType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      gutterIconPath: addedGutterUri,
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    // Маркер удаленных строк (красный треугольник в gutter + метка на полосе прокрутки)
    this.deletedLineType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      gutterIconPath: deletedGutterUri,
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
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

    // Слушаем редактирование документа в редакторе
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const active = vscode.window.activeTextEditor;
        if (active && active.document === e.document) {
          this.decorateEditor(active);
        }
      })
    );

    // Подсвечиваем все открытые редакторы
    this.refreshAllVisibleEditors();
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
    const maxLine = Math.max(0, editor.document.lineCount - 1);

    for (const hunk of change.hunks) {
      const start = Math.max(0, Math.min(maxLine, hunk.startLine - 1));
      const end = Math.max(0, Math.min(maxLine, hunk.endLine - 1));

      if (hunk.isAddition) {
        // Задаем диапазон всей строки
        addedRanges.push(new vscode.Range(start, 0, end, 1000));
      } else {
        deletedRanges.push(new vscode.Range(start, 0, start, 1000));
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
