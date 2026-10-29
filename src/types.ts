import * as vscode from 'vscode';

/**
 * Диапазон измененных строк
 */
export interface DiffHunkRange {
  startLine: number;
  endLine: number;
  isAddition: boolean;
}

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
  hunks: DiffHunkRange[];
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
  folderName: string; // Например, "2026_10_29_14_03_29"
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
  enableHighlight: boolean;
  maxAutoOpenFiles: number;
  showNotification: boolean;
  treeViewMode: 'tree' | 'flat';
  autoArchive: boolean;
  autoArchiveSeconds: number;
  protectedPatterns: string[];
  ignorePatterns: string[];
  debounceMs: number;
}
