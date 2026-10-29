import * as vscode from 'vscode';

/**
 * Информация об изменении файла внешним агентом
 */
export interface FileChangeInfo {
  uri: vscode.Uri;
  fsPath: string;
  relativeName: string;
  timestamp: number;
  changedLinesSummary: string;
  firstChangedLine?: number;
  addedLines: number;
  deletedLines: number;
  isProtected: boolean;
  isUntracked: boolean;
  isDeleted: boolean;
}

/**
 * Чекпоинт (шаг выполнения промпта) в истории
 */
export interface TurnCheckpoint {
  id: string;
  stepNumber: number;
  title: string;
  timestamp: number;
  files: FileChangeInfo[];
  snapshotDir?: string;
}

/**
 * Конфигурация расширения
 */
export interface ExtensionConfig {
  enable: boolean;
  autoOpen: boolean;
  openMode: 'diff' | 'document';
  openLocation: 'beside' | 'active';
  jumpToFirstChange: boolean;
  showNotification: boolean;
  treeViewMode: 'tree' | 'flat';
  autoArchive: boolean;
  autoArchiveSeconds: number;
  protectedPatterns: string[];
  ignorePatterns: string[];
  debounceMs: number;
}
