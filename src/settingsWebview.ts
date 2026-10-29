import * as vscode from 'vscode';
import { IgnoreManager } from './ignoreManager';

/**
 * Панель настроек расширения на базе Webview
 */
export class SettingsWebviewPanel {
  public static currentPanel: SettingsWebviewPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly ignoreManager: IgnoreManager
  ) {
    this._panel = panel;

    // Обновляем HTML контент
    this.update();

    // Слушаем закрытие панели
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Слушаем сообщения от веб-страницы
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this.handleMessage(message);
      },
      null,
      this._disposables
    );

    // Слушаем изменения правил .agentignore
    this.ignoreManager.onDidChange(() => {
      this.sendCurrentState();
    }, null, this._disposables);
  }

  public static createOrShow(extensionUri: vscode.Uri, ignoreManager: IgnoreManager) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SettingsWebviewPanel.currentPanel) {
      SettingsWebviewPanel.currentPanel._panel.reveal(column);
      SettingsWebviewPanel.currentPanel.sendCurrentState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentInspectorSettings',
      'Настройки: Agent Inspector',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    SettingsWebviewPanel.currentPanel = new SettingsWebviewPanel(
      panel,
      extensionUri,
      ignoreManager
    );
  }

  private async handleMessage(message: any) {
    const cfg = vscode.workspace.getConfiguration('agentDiff');

    switch (message.command) {
      case 'getState': {
        this.sendCurrentState();
        break;
      }
      case 'addIgnorePattern': {
        if (message.pattern) {
          await this.ignoreManager.addPattern(message.pattern);
          vscode.window.showInformationMessage(`Добавлено правило: ${message.pattern}`);
          this.sendCurrentState();
        }
        break;
      }
      case 'removeIgnorePattern': {
        if (message.pattern) {
          await this.ignoreManager.removePattern(message.pattern);
          vscode.window.showInformationMessage(`Удалено правило: ${message.pattern}`);
          this.sendCurrentState();
        }
        break;
      }
      case 'resyncGitignore': {
        const count = await this.ignoreManager.generateFromGitignore();
        vscode.window.showInformationMessage(
          `Правила .agentignore обновлены на основе ${count} файлов .gitignore.`
        );
        this.sendCurrentState();
        break;
      }
      case 'openAgentIgnoreFile': {
        const filePath = this.ignoreManager.getFilePath();
        if (filePath) {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          await vscode.window.showTextDocument(doc);
        }
        break;
      }
      case 'updateConfig': {
        if (message.key && message.value !== undefined) {
          await cfg.update(message.key, message.value, vscode.ConfigurationTarget.Global);
          this.sendCurrentState();
        }
        break;
      }
      case 'addProtectedPattern': {
        if (message.pattern) {
          const current = cfg.get<string[]>('protectedPatterns', []);
          if (!current.includes(message.pattern)) {
            const updated = [...current, message.pattern];
            await cfg.update('protectedPatterns', updated, vscode.ConfigurationTarget.Global);
            this.sendCurrentState();
          }
        }
        break;
      }
      case 'removeProtectedPattern': {
        if (message.pattern) {
          const current = cfg.get<string[]>('protectedPatterns', []);
          const updated = current.filter((p) => p !== message.pattern);
          await cfg.update('protectedPatterns', updated, vscode.ConfigurationTarget.Global);
          this.sendCurrentState();
        }
        break;
      }
    }
  }

  private sendCurrentState() {
    const cfg = vscode.workspace.getConfiguration('agentDiff');
    const state = {
      patterns: this.ignoreManager.getPatterns(),
      ignoreFilePath: this.ignoreManager.getFilePath(),
      autoOpen: cfg.get<boolean>('autoOpen', true),
      openMode: cfg.get<string>('openMode', 'diff'),
      jumpToFirstChange: cfg.get<boolean>('jumpToFirstChange', true),
      showNotification: cfg.get<boolean>('showNotification', true),
      protectedPatterns: cfg.get<string[]>('protectedPatterns', []),
    };

    this._panel.webview.postMessage({ type: 'state', state });
  }

  private update() {
    this._panel.title = 'Настройки: Agent Inspector';
    this._panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Настройки Agent Inspector</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --card-bg: var(--vscode-sideBar-background);
      --border: var(--vscode-panel-border, rgba(128,128,128,0.25));
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border, transparent);
      --input-fg: var(--vscode-input-foreground);
    }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      padding: 24px;
      margin: 0;
      max-width: 860px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .subtitle {
      opacity: 0.8;
      margin-bottom: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px 20px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .card-desc {
      font-size: 12px;
      opacity: 0.8;
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .btn-row {
      display: flex;
      gap: 10px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    button {
      background-color: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      padding: 7px 14px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 500;
    }
    button:hover {
      background-color: var(--btn-hover);
    }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }
    button.secondary:hover {
      background: rgba(128,128,128,0.15);
    }
    .input-group {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    input[type="text"] {
      flex: 1;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      padding: 7px 10px;
      border-radius: 4px;
      font-size: 13px;
    }
    input[type="text"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      max-height: 250px;
      overflow-y: auto;
      padding: 4px;
    }
    .chip {
      background: rgba(128,128,128,0.12);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 4px 10px;
      font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .chip .remove {
      cursor: pointer;
      opacity: 0.6;
      font-weight: bold;
    }
    .chip .remove:hover {
      opacity: 1;
      color: var(--vscode-errorForeground, #f48771);
    }
    .setting-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .setting-item:last-child {
      border-bottom: none;
    }
    .setting-info {
      max-width: 80%;
    }
    .setting-name {
      font-weight: 500;
      margin-bottom: 3px;
    }
    .setting-desc {
      font-size: 12px;
      opacity: 0.75;
    }
    select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      padding: 5px 8px;
      border-radius: 4px;
    }
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <h1>🤖 Настройки: Agent Change Inspector</h1>
  <div class="subtitle">Управление правилами игнорирования, поведением вкладок и защитой файлов проекта</div>

  <!-- БЛОК 1: ИСКЛЮЧЕНИЯ .agentignore -->
  <div class="card">
    <div class="card-title">
      <span>📁 Правила исключений (<span style="color: var(--vscode-textLink-foreground)">.agentignore</span>)</span>
      <span id="rulesCount" style="font-size: 12px; opacity: 0.8">0 правил</span>
    </div>
    <div class="card-desc">
      Файлы и папки, перечисленные здесь, полностью игнорируются при отслеживании действий ИИ. 
      При первом запуске список формируется на основе всех обнаруженных <code>.gitignore</code> файлов проекта и его подпапок.
    </div>

    <div class="btn-row">
      <button onclick="resyncGitignore()">🔄 Пересканировать все .gitignore</button>
      <button class="secondary" onclick="openFile()">📝 Открыть .agentignore в редакторе</button>
    </div>

    <div class="input-group">
      <input type="text" id="newPatternInput" placeholder="Добавить маску или путь (например: **/temp/**, cache/, *.bin)" onkeydown="if(event.key==='Enter') addPattern()">
      <button onclick="addPattern()">+ Добавить</button>
    </div>

    <div class="chip-list" id="patternsList">
      <!-- Сюда вставляются чипы -->
    </div>
  </div>

  <!-- БЛОК 2: ПОВЕДЕНИЕ ВКЛАДОК -->
  <div class="card">
    <div class="card-title">⚡ Поведение при изменениях</div>
    
    <div class="setting-item">
      <div class="setting-info">
        <div class="setting-name">Автоматически открывать измененные файлы</div>
        <div class="setting-desc">Автоматически открывать постоянную вкладку, когда ИИ меняет файл на диске</div>
      </div>
      <input type="checkbox" id="autoOpenCheck" onchange="updateConfig('autoOpen', this.checked)">
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <div class="setting-name">Режим открытия</div>
        <div class="setting-desc">Окно сравнения Diff (рекомендуется) или обычная вкладка с кодом</div>
      </div>
      <select id="openModeSelect" onchange="updateConfig('openMode', this.value)">
        <option value="diff">Diff (Окно сравнения Git)</option>
        <option value="document">Обычный документ</option>
      </select>
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <div class="setting-name">Авто-скролл к первой измененной строке</div>
        <div class="setting-desc">Сразу прокручивать экран и ставить курсор на блок правок</div>
      </div>
      <input type="checkbox" id="jumpCheck" onchange="updateConfig('jumpToFirstChange', this.checked)">
    </div>

    <div class="setting-item">
      <div class="setting-info">
        <div class="setting-name">Всплывающие уведомления</div>
        <div class="setting-desc">Показывать всплывающее окно со сводкой строк и кнопкой быстрого отката</div>
      </div>
      <input type="checkbox" id="notifyCheck" onchange="updateConfig('showNotification', this.checked)">
    </div>
  </div>

  <!-- БЛОК 3: ЗАЩИЩЕННЫЕ ФАЙЛЫ -->
  <div class="card">
    <div class="card-title">🛡️ Защищенные файлы (Запрет правок ИИ)</div>
    <div class="card-desc">
      Если ИИ попытается изменить файлы, соответствующие этим маскам, VS Code немедленно выдаст предупреждение с предложением отката.
    </div>

    <div class="input-group">
      <input type="text" id="newProtectedInput" placeholder="Маска защищенного файла (например: **/.env*, **/auth/**)" onkeydown="if(event.key==='Enter') addProtected()">
      <button onclick="addProtected()">+ Защитить</button>
    </div>

    <div class="chip-list" id="protectedList">
      <!-- Защищенные файлы -->
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'state') {
        renderState(msg.state);
      }
    });

    // Запрос текущего состояния при открытии
    vscode.postMessage({ command: 'getState' });

    function renderState(state) {
      // 1. Игнорируемые правила
      const patternsList = document.getElementById('patternsList');
      patternsList.innerHTML = '';
      const patterns = state.patterns || [];
      document.getElementById('rulesCount').innerText = patterns.length + ' правил';

      patterns.forEach(p => {
        if (!p.startsWith('#')) {
          const chip = document.createElement('div');
          chip.className = 'chip';
          chip.innerHTML = '<span>' + escapeHtml(p) + '</span><span class="remove" onclick="removePattern(\\'' + escapeHtml(p) + '\\')">✕</span>';
          patternsList.appendChild(chip);
        }
      });

      // 2. Настройки
      document.getElementById('autoOpenCheck').checked = !!state.autoOpen;
      document.getElementById('openModeSelect').value = state.openMode || 'diff';
      document.getElementById('jumpCheck').checked = !!state.jumpToFirstChange;
      document.getElementById('notifyCheck').checked = !!state.showNotification;

      // 3. Защищенные файлы
      const protectedList = document.getElementById('protectedList');
      protectedList.innerHTML = '';
      (state.protectedPatterns || []).forEach(p => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.style.borderColor = 'var(--vscode-inputValidation-warningBorder, orange)';
        chip.innerHTML = '<span>' + escapeHtml(p) + '</span><span class="remove" onclick="removeProtected(\\'' + escapeHtml(p) + '\\')">✕</span>';
        protectedList.appendChild(chip);
      });
    }

    function addPattern() {
      const input = document.getElementById('newPatternInput');
      const val = input.value.trim();
      if (val) {
        vscode.postMessage({ command: 'addIgnorePattern', pattern: val });
        input.value = '';
      }
    }

    function removePattern(pat) {
      vscode.postMessage({ command: 'removeIgnorePattern', pattern: pat });
    }

    function addProtected() {
      const input = document.getElementById('newProtectedInput');
      const val = input.value.trim();
      if (val) {
        vscode.postMessage({ command: 'addProtectedPattern', pattern: val });
        input.value = '';
      }
    }

    function removeProtected(pat) {
      vscode.postMessage({ command: 'removeProtectedPattern', pattern: pat });
    }

    function resyncGitignore() {
      vscode.postMessage({ command: 'resyncGitignore' });
    }

    function openFile() {
      vscode.postMessage({ command: 'openAgentIgnoreFile' });
    }

    function updateConfig(key, value) {
      vscode.postMessage({ command: 'updateConfig', key, value });
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
  </script>
</body>
</html>`;
  }

  public dispose() {
    SettingsWebviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}
