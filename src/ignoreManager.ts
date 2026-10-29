import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import ignore, { Ignore } from 'ignore';

const DEFAULT_IGNORE_PATTERNS = [
  '# Системные папки и зависимости',
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.cache/',
  '.agents/',
  'tmp/',
  '*.log',
  '.agentignore',
  '.agent-inspector/',
];

/**
 * Менеджер правил игнорирования (.agentignore)
 */
export class IgnoreManager implements vscode.Disposable {
  private ig: Ignore = ignore();
  private patterns: string[] = [];
  private agentIgnorePath: string | null = null;
  private fileWatcher: vscode.FileSystemWatcher | null = null;
  private disposables: vscode.Disposable[] = [];

  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this.init();
  }

  /**
   * Инициализация менеджера: поиск или создание .agent-inspector/.agentignore
   */
  async init() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      this.ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
      return;
    }

    const rootPath = workspaceFolder.uri.fsPath;
    const inspectorDir = path.join(rootPath, '.agent-inspector');
    this.agentIgnorePath = path.join(inspectorDir, '.agentignore');

    // Гарантируем наличие папки .agent-inspector
    try {
      if (!fs.existsSync(inspectorDir)) {
        fs.mkdirSync(inspectorDir, { recursive: true });
      }
      const gitignorePath = path.join(inspectorDir, '.gitignore');
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, '*\n', 'utf-8');
      }
    } catch (err) {
      console.error('Ошибка подготовки папки .agent-inspector:', err);
    }

    // Авто-миграция: если старый .agentignore лежал в корне — переносим в .agent-inspector
    const legacyAgentIgnore = path.join(rootPath, '.agentignore');
    try {
      if (fs.existsSync(legacyAgentIgnore)) {
        if (!fs.existsSync(this.agentIgnorePath)) {
          await fs.promises.copyFile(legacyAgentIgnore, this.agentIgnorePath);
        }
        await fs.promises.unlink(legacyAgentIgnore).catch(() => {});
      }
    } catch (err) {
      console.error('Ошибка миграции .agentignore в .agent-inspector:', err);
    }

    // Если .agentignore не существует — собираем его из всех .gitignore проекта
    if (!fs.existsSync(this.agentIgnorePath)) {
      await this.generateFromGitignore();
    } else {
      await this.loadPatterns();
    }

    // Следим за изменениями файла .agent-inspector/.agentignore
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceFolder, '.agent-inspector/.agentignore')
    );

    this.disposables.push(
      this.fileWatcher.onDidChange(() => this.loadPatterns()),
      this.fileWatcher.onDidCreate(() => this.loadPatterns()),
      this.fileWatcher.onDidDelete(() => {
        this.patterns = [];
        this.ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
        this._onDidChange.fire();
      }),
      this.fileWatcher
    );
  }

  /**
   * Загрузка паттернов из файла .agentignore
   */
  async loadPatterns() {
    if (!this.agentIgnorePath || !fs.existsSync(this.agentIgnorePath)) {
      this.ig = ignore().add(DEFAULT_IGNORE_PATTERNS);
      this.patterns = DEFAULT_IGNORE_PATTERNS.filter(
        (p) => !p.startsWith('#') && p.trim().length > 0
      );
      this._onDidChange.fire();
      return;
    }

    try {
      const content = await fs.promises.readFile(this.agentIgnorePath, 'utf-8');
      const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      this.patterns = lines;
      const validRules = lines.filter((l) => !l.startsWith('#'));

      this.ig = ignore().add(validRules);
      this._onDidChange.fire();
    } catch (err) {
      console.error('Ошибка чтения .agentignore:', err);
    }
  }

  /**
   * Собрать и сгенерировать .agentignore из всех .gitignore в проекте
   */
  async generateFromGitignore(): Promise<number> {
    if (!this.agentIgnorePath) {
      return 0;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return 0;
    }

    const rootPath = workspaceFolder.uri.fsPath;
    const collectedRules = new Set<string>();

    // Добавляем дефолтные правила
    for (const rule of DEFAULT_IGNORE_PATTERNS) {
      collectedRules.add(rule);
    }

    // Ищем все .gitignore во всех подпапках
    const gitignoreFiles = await vscode.workspace.findFiles(
      '**/.gitignore',
      '**/node_modules/**'
    );

    for (const fileUri of gitignoreFiles) {
      try {
        const fileContent = await fs.promises.readFile(fileUri.fsPath, 'utf-8');
        const fileDir = path.dirname(fileUri.fsPath);
        const relDir = path.relative(rootPath, fileDir).replace(/\\/g, '/');

        const lines = fileContent.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) {
            continue;
          }

          // Если .gitignore во вложенной папке, добавляем префикс пути
          if (relDir && relDir !== '.') {
            if (trimmed.startsWith('/')) {
              collectedRules.add(`${relDir}${trimmed}`);
            } else if (!trimmed.startsWith('!')) {
              collectedRules.add(`${relDir}/**/${trimmed}`);
            } else {
              collectedRules.add(trimmed);
            }
          } else {
            collectedRules.add(trimmed);
          }
        }
      } catch (err) {
        console.error(`Ошибка при чтении ${fileUri.fsPath}:`, err);
      }
    }

    // Записываем файл .agentignore
    const fileContent = Array.from(collectedRules).join('\n') + '\n';
    await fs.promises.writeFile(this.agentIgnorePath, fileContent, 'utf-8');

    await this.loadPatterns();
    return gitignoreFiles.length;
  }

  /**
   * Проверить, должен ли файл игнорироваться
   */
  isIgnored(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\//, '');
    if (!normalized) {
      return false;
    }

    // Всегда игнорируем сам .agentignore, папку .agent-inspector и .git
    if (
      normalized === '.agentignore' ||
      normalized.endsWith('/.agentignore') ||
      normalized.startsWith('.git/') ||
      normalized.startsWith('.agent-inspector/')
    ) {
      return true;
    }

    try {
      return this.ig.ignores(normalized);
    } catch {
      return false;
    }
  }

  /**
   * Получить текущие активные правила
   */
  getPatterns(): string[] {
    return this.patterns;
  }

  /**
   * Добавить новое правило
   */
  async addPattern(pattern: string): Promise<void> {
    const clean = pattern.trim();
    if (!clean || !this.agentIgnorePath) {
      return;
    }

    let content = '';
    if (fs.existsSync(this.agentIgnorePath)) {
      content = await fs.promises.readFile(this.agentIgnorePath, 'utf-8');
    }

    const lines = content.split(/\r?\n/);
    if (!lines.includes(clean)) {
      lines.push(clean);
      await fs.promises.writeFile(this.agentIgnorePath, lines.join('\n') + '\n', 'utf-8');
      await this.loadPatterns();
    }
  }

  /**
   * Удалить правило
   */
  async removePattern(pattern: string): Promise<void> {
    const clean = pattern.trim();
    if (!clean || !this.agentIgnorePath || !fs.existsSync(this.agentIgnorePath)) {
      return;
    }

    const content = await fs.promises.readFile(this.agentIgnorePath, 'utf-8');
    const lines = content
      .split(/\r?\n/)
      .filter((l) => l.trim() !== clean);

    await fs.promises.writeFile(this.agentIgnorePath, lines.join('\n') + '\n', 'utf-8');
    await this.loadPatterns();
  }

  getFilePath(): string | null {
    return this.agentIgnorePath;
  }

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
