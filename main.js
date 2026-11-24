const { FuzzySuggestModal, Notice, Plugin, PluginSettingTab, Setting, TFolder, getLinkpath } = require("obsidian");

const TEXT_HIGHLIGHTS = [
  { key: "bold", name: "Bold text", defaultColor: "#4da3ff" },
  { key: "italic", name: "Italic text", defaultColor: "#ff8c00" }
];

const DEFAULT_INLINE_CODE_COLOR = "#c792ea";
const INLINE_CODE_COLOR = "--colorlogic-inline-code-color";

const EXPLORER_TITLE = ".nav-files-container :is(.nav-folder-title, .nav-file-title)";
const EXPLORER_MARK = "colorlogic-explorer-highlight";
const EXPLORER_COLOR = "--colorlogic-explorer-color";
const UNUSED_FILE_COLOR = "#ff8c00";

function isColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

module.exports = class InlineCodeClickCopyPlugin extends Plugin {
  async onload() {
    const saved = await this.loadData();
    this.settings = {};
    for (const { key, defaultColor } of TEXT_HIGHLIGHTS) {
      const { enabled, color } = saved?.[key] ?? {};
      this.settings[key] = {
        enabled: typeof enabled === "boolean" ? enabled : true,
        color: isColor(color) ? color : defaultColor
      };
    }
    const { mode, color } = saved?.inlineCode ?? {};
    this.settings.inlineCode = {
      mode: mode === "custom" ? "custom" : "default",
      color: isColor(color) ? color : DEFAULT_INLINE_CODE_COLOR
    };
    this.settings.explorerRules = Array.isArray(saved?.explorerRules)
      ? saved.explorerRules.filter((rule) =>
        (rule?.type === "folder" || rule?.type === "file") &&
        Number.isSafeInteger(rule.level) && rule.level > 0 && isColor(rule.color))
      : [];
    this.settings.unusedFilesFolder = typeof saved?.unusedFilesFolder === "string"
      ? saved.unusedFilesFolder
      : "";

    this.settingsWrite = Promise.resolve();
    this.highlightDocuments = new Set();
    this.explorerObservers = new Map();
    this.unusedFolderPrefix = null;
    this.linkedFiles = new Set();
    this.onDocumentClick = (event) => {
      this.handleDocumentClick(event);
    };
    this.indexExplorerRules();
    this.addHighlightDocument(document);
    this.addSettingTab(new ColorLogicSettingTab(this.app, this));

    const { workspace } = this.app;
    this.registerEvent(this.app.metadataCache.on("resolved", () => {
      if (this.settings.unusedFilesFolder) {
        this.refreshUnusedFiles();
      }
    }));
    this.registerEvent(workspace.on("window-open", (_workspaceWindow, popup) => {
      this.addHighlightDocument(popup.document);
    }));
    this.registerEvent(workspace.on("window-close", (workspaceWindow) => {
      const doc = workspaceWindow.containerEl.ownerDocument;
      doc.removeEventListener("click", this.onDocumentClick);
      this.explorerObservers.get(doc)?.disconnect();
      this.explorerObservers.delete(doc);
      this.highlightDocuments.delete(doc);
    }));

    this.registerDomEvent(window, "resize", () => {
      this.queueMultilineInlineCodeScan(document);
    });

    this.registerMarkdownPostProcessor((element) => {
      this.markMultilineInlineCode(element);
      this.queueMultilineInlineCodeScan(element);
    });

    workspace.onLayoutReady(() => {
      if (!this.highlightDocuments.has(document)) {
        return;
      }

      if (this.settings.unusedFilesFolder) {
        this.refreshUnusedFiles();
      }
      workspace.iterateAllLeaves((leaf) => {
        this.addHighlightDocument(leaf.view.containerEl.ownerDocument);
      });
      this.markMultilineInlineCode(document);
      this.queueMultilineInlineCodeScan(document);
    });
  }

  onunload() {
    for (const doc of this.highlightDocuments ?? []) {
      doc.removeEventListener("click", this.onDocumentClick);
      const { body } = doc;
      for (const { key } of TEXT_HIGHLIGHTS) {
        body.classList.remove(`colorlogic-highlight-${key}`);
        body.style.removeProperty(`--colorlogic-${key}-color`);
      }
      body.style.removeProperty(INLINE_CODE_COLOR);
      this.clearExplorerHighlights(doc);
    }
    this.highlightDocuments?.clear();
  }

  addHighlightDocument(doc) {
    if (this.highlightDocuments.has(doc)) {
      return;
    }

    this.highlightDocuments.add(doc);
    doc.addEventListener("click", this.onDocumentClick);
    this.applyHighlights(doc);
    this.applyInlineCodeColors(doc);
    this.refreshExplorerHighlights(doc);
  }

  applyHighlights({ body }) {
    for (const { key } of TEXT_HIGHLIGHTS) {
      const { enabled, color } = this.settings[key];
      body.classList.toggle(`colorlogic-highlight-${key}`, enabled);
      body.style.setProperty(`--colorlogic-${key}-color`, color);
    }
  }

  updateHighlight(key, change) {
    this.settings = { ...this.settings, [key]: { ...this.settings[key], ...change } };
    for (const doc of this.highlightDocuments) {
      this.applyHighlights(doc);
    }
    return this.saveSettings();
  }

  applyInlineCodeColors({ body }) {
    const { mode, color } = this.settings.inlineCode;
    if (mode === "custom") {
      body.style.setProperty(INLINE_CODE_COLOR, color);
    } else {
      body.style.removeProperty(INLINE_CODE_COLOR);
    }
  }

  updateInlineCode(change) {
    this.settings = { ...this.settings, inlineCode: { ...this.settings.inlineCode, ...change } };
    for (const doc of this.highlightDocuments) {
      this.applyInlineCodeColors(doc);
    }
    return this.saveSettings();
  }

  saveSettings() {
    const settings = this.settings;
    this.settingsWrite = this.settingsWrite
      .then(() => this.saveData(settings))
      .catch((error) => {
        console.error("ColorLogic: failed to save settings", error);
        new Notice("ColorLogic could not save the highlight settings.");
      });
    return this.settingsWrite;
  }

  setExplorerRules(rules) {
    this.settings = { ...this.settings, explorerRules: rules };
    this.indexExplorerRules();
    for (const doc of this.highlightDocuments) {
      this.refreshExplorerHighlights(doc);
    }
    return this.saveSettings();
  }

  indexExplorerRules() {
    this.explorerColors = new Map();
    for (const { type, level, color } of this.settings.explorerRules) {
      this.explorerColors.set(`${type}:${level}`, color);
    }
  }

  setUnusedFilesFolder(path) {
    this.settings = { ...this.settings, unusedFilesFolder: path };
    this.refreshUnusedFiles();
    return this.saveSettings();
  }

  refreshUnusedFiles() {
    const folder = this.settings.unusedFilesFolder;
    this.unusedFolderPrefix = folder === "/" ? "" : folder ? `${folder}/` : null;
    this.linkedFiles.clear();

    if (this.unusedFolderPrefix !== null) {
      const { metadataCache } = this.app;
      for (const [source, links] of Object.entries(metadataCache.resolvedLinks)) {
        for (const [target, count] of Object.entries(links)) {
          if (count <= 0 || !target.startsWith(this.unusedFolderPrefix) ||
              this.linkedFiles.has(target)) {
            continue;
          }

          if (source === target && source.toLowerCase().endsWith(".md")) {
            // A local heading or block link targets its own note in the index.
            const cache = metadataCache.getCache(source);
            const explicitLink = [cache?.links, cache?.embeds, cache?.frontmatterLinks]
              .some((references) => references?.some(({ link }) => {
                const path = getLinkpath(link);
                return path && metadataCache.getFirstLinkpathDest(path, source)?.path === target;
              }));
            if (!explicitLink) {
              continue;
            }
          }

          this.linkedFiles.add(target);
        }
      }
    }

    for (const doc of this.highlightDocuments) {
      this.refreshExplorerHighlights(doc);
    }
  }

  refreshExplorerHighlights(doc) {
    if (this.explorerColors.size === 0 && this.unusedFolderPrefix === null) {
      this.clearExplorerHighlights(doc);
      return;
    }

    for (const title of doc.querySelectorAll(EXPLORER_TITLE)) {
      this.colorExplorerTitle(title);
    }

    if (!this.explorerObservers.has(doc)) {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "attributes") {
            if (record.target.matches(EXPLORER_TITLE)) {
              this.colorExplorerTitle(record.target);
            }
            continue;
          }

          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) {
              continue;
            }
            if (node.matches(EXPLORER_TITLE)) {
              this.colorExplorerTitle(node);
            }
            for (const title of node.querySelectorAll(EXPLORER_TITLE)) {
              this.colorExplorerTitle(title);
            }
          }
        }
      });
      observer.observe(doc.body, {
        subtree: true,
        childList: true,
        attributeFilter: ["data-path"]
      });
      this.explorerObservers.set(doc, observer);
    }
  }

  clearExplorerHighlights(doc) {
    this.explorerObservers.get(doc)?.disconnect();
    this.explorerObservers.delete(doc);
    for (const title of doc.querySelectorAll(`.${EXPLORER_MARK}`)) {
      title.classList.remove(EXPLORER_MARK);
      title.style.removeProperty(EXPLORER_COLOR);
    }
  }

  colorExplorerTitle(title) {
    const path = title.getAttribute("data-path");
    const type = title.classList.contains("nav-folder-title") ? "folder" : "file";
    let color;
    if (path && path !== "/") {
      color = this.explorerColors.get(`${type}:${path.split("/").length}`);
      if (type === "file" && this.unusedFolderPrefix !== null &&
          path.startsWith(this.unusedFolderPrefix) && !this.linkedFiles.has(path)) {
        color = UNUSED_FILE_COLOR;
      }
    }
    title.classList.toggle(EXPLORER_MARK, Boolean(color));
    if (color) {
      title.style.setProperty(EXPLORER_COLOR, color);
    } else {
      title.style.removeProperty(EXPLORER_COLOR);
    }
  }

  async handleDocumentClick(event) {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    const codeElement = this.getInlineCodeElement(event.target);
    if (!codeElement) {
      return;
    }

    const text = codeElement.textContent ?? "";
    if (!text) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    try {
      await this.copyText(text, codeElement.ownerDocument);
      new Notice("Inline code copied");
    } catch (error) {
      console.error("Inline Code Click Copy: failed to copy inline code", error);
      new Notice("Failed to copy inline code");
    }
  }

  getInlineCodeElement(target) {
    const targetWindow = target?.ownerDocument?.defaultView;
    if (!targetWindow || !(target instanceof targetWindow.HTMLElement)) {
      return null;
    }

    const codeElement = target.closest("code");
    if (!codeElement) {
      return null;
    }

    if (!codeElement.closest(".markdown-reading-view, .markdown-preview-view")) {
      return null;
    }

    if (codeElement.closest("pre")) {
      return null;
    }

    return codeElement;
  }

  queueMultilineInlineCodeScan(container) {
    requestAnimationFrame(() => {
      this.markMultilineInlineCode(container, true);
    });
  }

  markMultilineInlineCode(container, detectWrappedLines = false) {
    const requireRenderedContext = container === document;

    container.querySelectorAll("code:not(pre code)").forEach((codeElement) => {
      if (
        requireRenderedContext &&
        !codeElement.closest(".markdown-reading-view, .markdown-preview-view")
      ) {
        return;
      }

      const text = codeElement.textContent ?? "";
      const isMultiline =
        /[\r\n]/.test(text) ||
        Boolean(codeElement.querySelector("br")) ||
        codeElement.classList.contains("inline-code-click-copy-multiline") ||
        (detectWrappedLines && codeElement.getClientRects().length > 1);
      codeElement.classList.toggle("inline-code-click-copy-multiline", isMultiline);
    });
  }

  async copyText(text, doc) {
    const clipboard = doc.defaultView.navigator.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return;
    }

    const textArea = doc.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.opacity = "0";
    doc.body.appendChild(textArea);
    textArea.select();

    const copied = doc.execCommand("copy");
    textArea.remove();

    if (!copied) {
      throw new Error("Copy command failed");
    }
  }
};

class ColorLogicSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl, plugin } = this;
    containerEl.empty();

    for (const { key, name } of TEXT_HIGHLIGHTS) {
      const { enabled, color } = plugin.settings[key];
      const setting = new Setting(containerEl)
        .setName(name)
        .addToggle((toggle) => toggle
          .setTooltip(`Highlight ${name.toLowerCase()}`)
          .setValue(enabled)
          .onChange((value) => plugin.updateHighlight(key, { enabled: value })))
        .addColorPicker((picker) => picker
          .setValue(color)
          .onChange((value) => plugin.updateHighlight(key, { color: value })));

      setting.controlEl.querySelector('input[type="color"]')
        ?.setAttribute("aria-label", `${name} highlight color`);
    }

    this.renderInlineCodeSettings();

    new Setting(containerEl)
      .setName("File explorer")
      .setHeading();

    new Setting(containerEl)
      .setName("Highlight rules")
      .setDesc("Items at the vault root are level 1. If rules overlap, the last one wins.")
      .addButton((button) => button
        .setButtonText("+ Add rule")
        .onClick(() => {
          const { explorerRules } = plugin.settings;
          plugin.setExplorerRules([
            ...explorerRules,
            { type: "folder", level: 1, color: "#4da3ff" }
          ]);
          this.display();
        }));

    plugin.settings.explorerRules.forEach((rule, index) => {
      this.renderExplorerRule(rule, index);
    });

    const folder = plugin.settings.unusedFilesFolder;
    const unusedFiles = new Setting(containerEl)
      .setName("Unused files")
      .setDesc(folder
        ? `Folder: ${folder === "/" ? "Vault root" : folder}. Files without incoming links are orange.`
        : "Choose a folder to color files without incoming links orange, including files in subfolders.")
      .addButton((button) => button
        .setButtonText("Choose folder")
        .onClick(() => {
          new UnusedFilesFolderModal(this.app, (path) => {
            plugin.setUnusedFilesFolder(path);
            this.display();
          }).open();
        }));
    if (folder) {
      unusedFiles.addExtraButton((button) => button
        .setIcon("x")
        .setTooltip("Clear unused files folder")
        .onClick(() => {
          plugin.setUnusedFilesFolder("");
          this.display();
        }));
    }
  }

  renderInlineCodeSettings() {
    const { containerEl, plugin } = this;
    const { mode, color } = plugin.settings.inlineCode;

    new Setting(containerEl)
      .setName("Inline code")
      .setHeading();

    let modeDropdown;
    new Setting(containerEl)
      .setName("Color mode")
      .addDropdown((dropdown) => {
        modeDropdown = dropdown;
        dropdown
          .addOption("default", "Default")
          .addOption("custom", "Custom")
          .setValue(mode);
        dropdown.selectEl.setAttribute("aria-label", "Inline code color mode");
      });

    const colorRow = containerEl.createDiv();
    colorRow.hidden = mode !== "custom";
    const colorSetting = new Setting(colorRow)
      .setName("Custom color")
      .addColorPicker((picker) => picker
        .setValue(color)
        .onChange((value) => plugin.updateInlineCode({ color: value })));
    colorSetting.controlEl.querySelector('input[type="color"]')
      ?.setAttribute("aria-label", "Custom inline code color");

    modeDropdown.onChange((value) => {
      colorRow.hidden = value !== "custom";
      return plugin.updateInlineCode({ mode: value });
    });
  }

  renderExplorerRule(rule, index) {
    const { containerEl, plugin } = this;
    const name = `Rule ${index + 1}`;
    const update = (change) => plugin.setExplorerRules(
      plugin.settings.explorerRules.map((current, position) =>
        position === index ? { ...current, ...change } : current)
    );

    const setting = new Setting(containerEl).setName(name);
    setting.settingEl.classList.add("colorlogic-explorer-rule");
    setting
      .addDropdown((dropdown) => {
        dropdown
          .addOption("folder", "Folder")
          .addOption("file", "File")
          .setValue(rule.type)
          .onChange((type) => update({ type }));
        dropdown.selectEl.setAttribute("aria-label", `${name} item type`);
      })
      .addText((text) => {
        const input = text.inputEl;
        input.type = "number";
        input.min = "1";
        input.step = "1";
        const label = input.ownerDocument.createElement("label");
        label.className = "colorlogic-explorer-level";
        input.before(label);
        label.append("Level", input);
        text.setValue(String(rule.level)).onChange((value) => {
          const level = Number(value);
          if (Number.isSafeInteger(level) && level > 0) {
            update({ level });
          }
        });
        input.addEventListener("blur", () => {
          input.value = String(plugin.settings.explorerRules[index]?.level ?? rule.level);
        });
      })
      .addColorPicker((picker) => picker
        .setValue(rule.color)
        .onChange((color) => update({ color })))
      .addExtraButton((button) => button
        .setIcon("trash-2")
        .setTooltip(`Remove ${name.toLowerCase()}`)
        .onClick(() => {
          plugin.setExplorerRules(
            plugin.settings.explorerRules.filter((_, position) => position !== index)
          );
          this.display();
        }));
    setting.controlEl.querySelector('input[type="color"]')
      ?.setAttribute("aria-label", `${name} highlight color`);
  }
}

class UnusedFilesFolderModal extends FuzzySuggestModal {
  constructor(app, onFolderSelected) {
    super(app);
    this.onFolderSelected = onFolderSelected;
    this.folders = app.vault.getAllLoadedFiles().filter((item) => item instanceof TFolder);
    this.setPlaceholder("Search folders");
  }

  getItems() {
    return this.folders;
  }

  getItemText(folder) {
    return folder.path === "/" ? "Vault root (/)" : folder.path;
  }

  onChooseItem(folder) {
    this.onFolderSelected(folder.path);
  }
}
