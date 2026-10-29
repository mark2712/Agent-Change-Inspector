import * as vscode from 'vscode';
import * as path from 'path';
import { FileChangeInfo } from './types';
import { getGitDiffSummary } from './gitHelper';

/**
 * Элемент дерева измененных файлов
 */
export class AgentTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly changeInfo?: FileChangeInfo,
    public readonly folderRelativePath?: string,
    public readonly isFolder: boolean = false
  ) {
    super(label, collapsibleState);

    if (isFolder) {
      this.contextValue = 'agentFolder';
      this.iconPath = vscode.ThemeIcon.Folder;
      this.tooltip = `Папка: ${folderRelativePath}`;
    } else if (changeInfo) {
      this.contextValue = changeInfo.isDeleted ? 'agentFileDeleted' : 'agentFile';
      this.resourceUri = changeInfo.uri;

      if (changeInfo.isDeleted) {
        // Ярко-красная иконка и пометка удаления
        this.iconPath = new vscode.ThemeIcon(
          'trash',
          new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
        );
        this.description = '🗑️ [Удален]';
        this.tooltip = `УДАЛЕН: ${changeInfo.relativeName}\nКликните для просмотра в Diff или отката`;
      } else {
        this.description = changeInfo.changedLinesSummary;
        this.tooltip = `${changeInfo.relativeName}\n${changeInfo.changedLinesSummary}\nВремя: ${new Date(
          changeInfo.timestamp
        ).toLocaleTimeString()}`;
      }

      // Команда по клику на элемент: открывает файл/дифф
      this.command = {
        command: 'agentDiff.openDiff',
        title: 'Открыть Diff',
        arguments: [this],
      };
    }
  }
}

/**
 * Провайдер подсветки цветов файлов (красный цвет для удаленных)
 */
export class AgentFileDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  constructor(private readonly getChangeInfo: (uri: vscode.Uri) => FileChangeInfo | undefined) {}

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const change = this.getChangeInfo(uri);
    if (change?.isDeleted) {
      return {
        badge: 'D',
        color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
        tooltip: 'Файл удален агентом',
        propagate: false,
      };
    }
    return undefined;
  }

  refresh(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }
}

/**
 * Провайдер дерева измененных файлов (Проводник правок ИИ)
 */
export class AgentChangesTreeProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<AgentTreeItem | undefined | void> =
    new vscode.EventEmitter<AgentTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<AgentTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private changesMap = new Map<string, FileChangeInfo>();
  private isTreeMode = true;

  constructor(private readonly treeViewMode: 'tree' | 'flat' = 'tree') {
    this.isTreeMode = treeViewMode === 'tree';
  }

  setTreeMode(mode: 'tree' | 'flat') {
    this.isTreeMode = mode === 'tree';
    this.refresh();
  }

  toggleTreeMode(): 'tree' | 'flat' {
    this.isTreeMode = !this.isTreeMode;
    this.refresh();
    return this.isTreeMode ? 'tree' : 'flat';
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  addOrUpdateChanges(changes: FileChangeInfo[]): void {
    for (const change of changes) {
      this.changesMap.set(change.fsPath, change);
    }
    this.refresh();
  }

  removeChange(fsPath: string): void {
    if (this.changesMap.delete(fsPath)) {
      this.refresh();
    }
  }

  clear(): void {
    this.changesMap.clear();
    this.refresh();
  }

  /**
   * Сверка всех текущих записей дерева с реальным состоянием Git
   * Удаляет файлы, где изменения были отменены (например, через Ctrl+Z или git restore)
   */
  async reconcileWithGit(workspaceRoot: string): Promise<boolean> {
    let hasChanged = false;
    for (const [fsPath, info] of Array.from(this.changesMap.entries())) {
      const gitInfo = await getGitDiffSummary(fsPath, workspaceRoot);

      if (!gitInfo.hasChanges) {
        // Изменений больше нет (отмена удаления или правки)
        this.changesMap.delete(fsPath);
        hasChanged = true;
      } else if (
        info.isDeleted !== gitInfo.isDeleted ||
        info.isUntracked !== gitInfo.isUntracked ||
        info.changedLinesSummary !== gitInfo.summaryText
      ) {
        // Состояние обновилось (например, файл пересоздан)
        this.changesMap.set(fsPath, {
          ...info,
          isDeleted: gitInfo.isDeleted,
          isUntracked: gitInfo.isUntracked,
          changedLinesSummary: gitInfo.summaryText,
          firstChangedLine: gitInfo.firstChangedLine,
          addedLines: gitInfo.addedLines,
          deletedLines: gitInfo.deletedLines,
        });
        hasChanged = true;
      }
    }

    if (hasChanged) {
      this.refresh();
    }

    return hasChanged;
  }

  getAllChanges(): FileChangeInfo[] {
    return Array.from(this.changesMap.values());
  }

  getChangeByUri(uri: vscode.Uri): FileChangeInfo | undefined {
    return this.changesMap.get(uri.fsPath);
  }

  getTreeItem(element: AgentTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: AgentTreeItem): Promise<AgentTreeItem[]> {
    const allChanges = Array.from(this.changesMap.values());

    if (allChanges.length === 0) {
      return [];
    }

    // Режим 1: Плоский список (Flat List)
    if (!this.isTreeMode) {
      return allChanges.map(
        (c) => new AgentTreeItem(path.basename(c.fsPath), vscode.TreeItemCollapsibleState.None, c)
      );
    }

    // Режим 2: Иерархическое дерево (как в Проводнике)
    const currentFolder = element ? element.folderRelativePath : '';

    const folders = new Map<string, string>();
    const files: FileChangeInfo[] = [];

    for (const change of allChanges) {
      const rel = change.relativeName.replace(/\\/g, '/');

      if (!currentFolder) {
        // Корневой уровень
        const slashIdx = rel.indexOf('/');
        if (slashIdx === -1) {
          files.push(change);
        } else {
          const topDir = rel.substring(0, slashIdx);
          folders.set(topDir, topDir);
        }
      } else {
        // Внутри папки currentFolder
        const prefix = currentFolder + '/';
        if (rel.startsWith(prefix)) {
          const remaining = rel.substring(prefix.length);
          const slashIdx = remaining.indexOf('/');
          if (slashIdx === -1) {
            files.push(change);
          } else {
            const nextDir = remaining.substring(0, slashIdx);
            const fullNextDir = `${currentFolder}/${nextDir}`;
            folders.set(fullNextDir, nextDir);
          }
        }
      }
    }

    const items: AgentTreeItem[] = [];

    // Добавляем папки
    for (const [fullPath, dirName] of folders.entries()) {
      items.push(
        new AgentTreeItem(
          dirName,
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          fullPath,
          true
        )
      );
    }

    // Добавляем файлы
    for (const file of files) {
      items.push(
        new AgentTreeItem(path.basename(file.fsPath), vscode.TreeItemCollapsibleState.None, file)
      );
    }

    return items;
  }
}
