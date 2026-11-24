# ColorLogic

ColorLogic styles Markdown text, copies inline code with a click in Reading view, and colors file and folder names in the file explorer.

## Install manually

1. Create a `colorlogic` folder inside your vault's `.obsidian/plugins/` directory. If you use a custom vault configuration folder, use its `plugins/` directory.
2. Copy `manifest.json`, `main.js`, and `styles.css` into that folder.
3. Restart Obsidian and enable **ColorLogic** under **Settings → Community plugins**.

## Use ColorLogic

- Bold text appears blue and italics orange by default. Open **Settings → ColorLogic** on desktop or mobile to choose a color or turn off highlighting independently for **Bold text** and **Italic text**. Changes apply immediately in Reading view and the Markdown editor.
- Under **Settings → ColorLogic → Inline code**, choose **Default** for the original purple palette or **Custom** to pick a color. In Reading view, the translucent background and rounded border follow your selection. Click inline code to copy it to the clipboard and see a confirmation.
- Horizontal rules take up less vertical space.

### File explorer colors

On desktop or mobile, open **Settings → ColorLogic → File explorer** and select **+ Add rule**. Pick **Folder** or **File**, enter the level, and choose a color. Level 1 is the vault root. For example, `Projects` and `Inbox.md` are level 1, while `Projects/Notes.md` is level 2.

Add a separate rule for each type and level you want to color. Changes apply to names in Obsidian's file explorer, and the last rule wins if more than one rule has the same type and level. New installs start without explorer rules.

### Unused files

In **Settings → ColorLogic → File explorer**, use **Unused files → Choose folder**. ColorLogic checks Obsidian's vault-wide link index, including wikilinks such as `[[Note]]` and embeds such as `![[Photo.png]]`. It colors the names of files with no incoming links orange throughout the selected folder and its subfolders. It updates the colors when Obsidian resolves links.

Orange takes priority over a file's level color while it has no incoming links. Clear the selected folder to turn off this feature.

ColorLogic uses the local clipboard and runs offline.

## Author

Kharchenko Oleksii

## License

[MIT](LICENSE)
