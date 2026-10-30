import * as vscode from 'vscode';

/**
 * Тип изменения файла
 */
export type FileChangeStatus = 'modified' | 'added' | 'deleted' | 'copied' | 'moved';

/**
 * Диапазон измененных строк
 */
export interface DiffHunkRange {
  startLine: number;
  endLine: number;
  isAddition: boolean;
}

/**
 * Информация об изменении файла
 */
export interface FileChangeInfo {
  uri: vscode.Uri;
  fsPath: string;
  relativeName: string;
  timestamp: number;
  status: FileChangeStatus;
  changedLinesSummary: string;
  firstChangedLine?: number;
  addedLines: number;
  deletedLines: number;
  isProtected: boolean;
  isUntracked: boolean;
  isDeleted: boolean;
  isBinary?: boolean;
  isLarge?: boolean;
  isUserSave?: boolean;
  hunks: DiffHunkRange[];
  snapshotPath?: string;
  oldRelativeName?: string;
}

/**
 * Чекпоинт (шаг) в истории
 */
export interface TurnCheckpoint {
  id: string;
  stepNumber: number;
  title: string;
  timestamp: number;
  files: FileChangeInfo[];
  folderName: string;
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
  maxFileSizeBytes: number;
  burstThresholdMs: number;
}
