import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ExtensionConfig, FileChangeInfo } from './types';

/**
 * Модуль открытия и навигации по измененным файлам (через Diff со снимком или обычную вкладку)
 */
export class DiffPresenter {
  constructor(
    private readonly getConfig: () => ExtensionConfig,
    private readonly onRevertFile?: (change: FileChangeInfo) => Promise<boolean>
  ) {}

  /**
   * Закрепить активную вкладку, чтобы убрать режим предпросмотра (курсив)
   */
  private async keepActiveTab(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.keepEditor');
    } catch {
      // Игнорируем
    }
  }

  /**
   * Открыть файл как постоянную вкладку документа с переходом к первой измененной строке
   */
  async openDocumentTab(
    change: FileChangeInfo,
    targetColumn?: vscode.ViewColumn
  ): Promise<vscode.TextEditor | undefined> {
    const config = this.getConfig();

    // Если файл удален, открываем снимок из архива
    if (change.isDeleted) {
      await this.openDiffTab(change, targetColumn);
      return undefined;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(change.uri);
      const viewColumn =
        targetColumn ??
        (config.openLocation === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);

      const line = Math.max(0, (change.firstChangedLine ?? 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);

      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn,
        preview: false,
        preserveFocus: false,
        selection: range,
      });

      await this.keepActiveTab();

      if (config.jumpToFirstChange) {
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }

      return editor;
    } catch (err) {
      console.error(`[AgentInspector] Ошибка при открытии файла ${change.fsPath}:`, err);
      return undefined;
    }
  }

  /**
   * Открыть окно сравнения (Diff) со снимком ДО изменений
   */
  async openDiffTab(
    change: FileChangeInfo,
    targetColumn?: vscode.ViewColumn
  ): Promise<void> {
    const config = this.getConfig();

    // 1. Если файл новый (добавленный) — снимка "до изменений" нет, открываем сам файл
    if (change.status === 'added' || (change.isUntracked && !change.isDeleted)) {
      await this.openDocumentTab(change, targetColumn);
      return;
    }

    // 2. Если файл удален, но есть снимок — открываем снимок
    if (change.isDeleted) {
      if (change.snapshotPath && fs.existsSync(change.snapshotPath)) {
        const snapshotUri = vscode.Uri.file(change.snapshotPath);
        await vscode.commands.executeCommand('vscode.open', snapshotUri);
        await this.keepActiveTab();
      } else {
        vscode.window.showWarningMessage(`Файл ${change.relativeName} удален, снимок недоступен.`);
      }
      return;
    }

    // 3. Если файл изменен и есть снимок ДО изменений — открываем встроенный VS Code Diff со снимком!
    if (change.snapshotPath && fs.existsSync(change.snapshotPath)) {
      const snapshotUri = vscode.Uri.file(change.snapshotPath);
      const workingUri = change.uri;
      const fileName = path.basename(change.fsPath);
      const title = `${fileName} (Снимок до правок ↔ Текущий)`;

      try {
        await vscode.commands.executeCommand('vscode.diff', snapshotUri, workingUri, title);
        await this.keepActiveTab();

        // Скроллим к изменению
        if (config.jumpToFirstChange && change.firstChangedLine) {
          const line = Math.max(0, change.firstChangedLine - 1);
          const activeEditor = vscode.window.activeTextEditor;
          if (activeEditor) {
            const range = new vscode.Range(line, 0, line, 0);
            activeEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          }
        }
        return;
      } catch (err) {
        console.error('[AgentInspector] Ошибка при вызове vscode.diff:', err);
      }
    }

    // Запасной вариант — открыть обычную вкладку
    await this.openDocumentTab(change, targetColumn);
  }

  /**
   * Обработка пакета изменений с защитой от лавины вкладок
   */
  async presentChanges(
    changes: FileChangeInfo[],
    shouldAutoOpen: boolean
  ): Promise<void> {
    const config = this.getConfig();
    if (changes.length === 0) {
      return;
    }

    // 1. Предупреждение о защищенных файлах (только для внешних изменений от агента)
    const protectedChanges = changes.filter((c) => c.isProtected && !c.isUserSave);
    if (protectedChanges.length > 0) {
      const names = protectedChanges.map((c) => c.relativeName).join(', ');
      vscode.window
        .showErrorMessage(
          `⚠️ ВНИМАНИЕ: Изменены защищенные файлы: ${names}`,
          'Откатить изменения',
          'Открыть файл'
        )
        .then(async (action) => {
          if (action === 'Откатить изменения' && this.onRevertFile) {
            for (const change of protectedChanges) {
              await this.onRevertFile(change);
            }
            vscode.window.showInformationMessage('Изменения в защищенных файлах откатаны.');
          } else if (action === 'Открыть файл') {
            await this.openDiffTab(protectedChanges[0]);
          }
        });
    }

    // 2. Автоматическое открытие вкладок:
    // Только если shouldAutoOpen === true (нет лавинного потока < 200 мс и размер пачки небольшой)
    // И ИСКЛЮЧАЕМ файлы, которые были сохранены самим пользователем в VS Code (!c.isUserSave)
    if (config.autoOpen && shouldAutoOpen) {
      const maxFiles = Math.max(1, config.maxAutoOpenFiles ?? 3);
      const filesToOpen = changes
        .filter((c) => !c.isBinary && !c.isLarge && !c.isUserSave)
        .slice(0, maxFiles);
      const targetColumn =
        config.openLocation === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;

      for (const change of filesToOpen) {
        if (config.openMode === 'diff' && !change.isUntracked && !change.isDeleted) {
          await this.openDiffTab(change, targetColumn);
        } else {
          await this.openDocumentTab(change, targetColumn);
        }
      }
    }
  }
}
