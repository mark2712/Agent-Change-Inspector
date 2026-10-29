import * as vscode from 'vscode';
import { ExtensionConfig, FileChangeInfo } from './types';
import { revertGitFile } from './gitHelper';

/**
 * Модуль открытия и навигации по измененным файлам
 */
export class DiffPresenter {
  constructor(private readonly getConfig: () => ExtensionConfig) {}

  /**
   * Закрепить активную вкладку, чтобы убрать режим предпросмотра (курсив)
   */
  private async keepActiveTab(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.keepEditor');
    } catch {
      // Игнорируем ошибку, если команда недоступна
    }
  }

  /**
   * Открыть файл как постоянную вкладку документа
   */
  async openDocumentTab(
    change: FileChangeInfo,
    targetColumn?: vscode.ViewColumn
  ): Promise<vscode.TextEditor | undefined> {
    const config = this.getConfig();

    // Если файл удален, открывать его как обычный документ невозможно — открываем Diff
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
      console.error(`Ошибка при открытии файла ${change.fsPath}:`, err);
      return undefined;
    }
  }

  /**
   * Открыть окно сравнения (Diff)
   */
  async openDiffTab(
    change: FileChangeInfo,
    targetColumn?: vscode.ViewColumn
  ): Promise<void> {
    const config = this.getConfig();

    // Если файл новый и неотслеживаемый в Git, Diff невозможен
    if (change.isUntracked && !change.isDeleted) {
      await this.openDocumentTab(change, targetColumn);
      return;
    }

    try {
      await vscode.commands.executeCommand('git.openChange', change.uri);
      await this.keepActiveTab();

      setTimeout(async () => {
        await this.keepActiveTab();
        if (config.jumpToFirstChange && !change.isDeleted) {
          try {
            await vscode.commands.executeCommand('workbench.action.compareEditor.nextChange');
          } catch {
            // Игнорируем
          }
        }
      }, 150);
    } catch {
      if (!change.isDeleted) {
        await this.openDocumentTab(change, targetColumn);
      }
    }
  }

  /**
   * Обработка пакета внешних изменений от агента с защитой от лавины вкладок
   */
  async presentChanges(changes: FileChangeInfo[]): Promise<void> {
    const config = this.getConfig();
    if (changes.length === 0) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const workspaceRoot = workspaceFolder ? workspaceFolder.uri.fsPath : process.cwd();

    // 1. Проверяем защищенные файлы
    const protectedChanges = changes.filter((c) => c.isProtected);
    if (protectedChanges.length > 0) {
      const names = protectedChanges.map((c) => c.relativeName).join(', ');
      vscode.window
        .showErrorMessage(
          `⚠️ ВНИМАНИЕ: Агент изменил защищенные файлы: ${names}`,
          'Откатить изменения',
          'Открыть файл'
        )
        .then(async (action) => {
          if (action === 'Откатить изменения') {
            for (const change of protectedChanges) {
              await revertGitFile(change.fsPath, workspaceRoot);
            }
            vscode.window.showInformationMessage('Изменения в защищенных файлах откатаны.');
          } else if (action === 'Открыть файл') {
            await this.openDiffTab(protectedChanges[0]);
          }
        });
    }

    // 2. АВТОМАТИЧЕСКОЕ ОТКРЫТИЕ ВКЛАДОК С ЗАЩИТОЙ ОТ ЛАВИНЫ:
    // Если изменено больше файлов, чем maxAutoOpenFiles, открываем только первые N файлов
    // (по умолчанию 5), чтобы редактор не зависал при пакетных операциях или копировании папок.
    const maxFiles = Math.max(1, config.maxAutoOpenFiles ?? 5);

    if (config.autoOpen) {
      const filesToOpen = changes.slice(0, maxFiles);
      const targetColumn =
        config.openLocation === 'beside' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;

      for (const change of filesToOpen) {
        if (change.isDeleted) {
          await this.openDiffTab(change, targetColumn);
        } else if (config.openMode === 'diff' && !change.isUntracked) {
          await this.openDiffTab(change, targetColumn);
        } else {
          await this.openDocumentTab(change, targetColumn);
        }
      }
    }
  }
}
