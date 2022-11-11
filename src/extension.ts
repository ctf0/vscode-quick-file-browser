import * as vscode from "vscode";
import { Uri, FileType, QuickInputButton, ThemeIcon, ViewColumn } from "vscode";
import * as OS from "os";
import * as OSPath from "path";

import { Result, None, Option, Some } from "./rust";
import { Path, endsWithPathSeparator } from "./path";
import { Rules } from "./filter";
import { FileItem, fileRecordCompare } from "./fileitem";
import { action, Action } from "./action";

export enum ConfigItem {
    RemoveIgnoredFiles = "removeIgnoredFiles",
    HideDotfiles = "hideDotfiles",
    HideIgnoreFiles = "hideIgnoredFiles",
    IgnoreFileTypes = "ignoreFileTypes",
    LabelIgnoredFiles = "labelIgnoredFiles",
    UriSchemeUriCommandMap = "uriSchemeUriCommandMap",
}

export function config<A>(item: ConfigItem): A | undefined {
    return vscode.workspace.getConfiguration("quick-file-browser").get(item);
}

let active: Option<FileBrowser> = None;

function setContext(state: boolean) {
    vscode.commands.executeCommand("setContext", "inFileBrowser", state);
}

interface AutoCompletion {
    index: number;
    items: FileItem[];
}

class FileBrowser {
    current: vscode.QuickPick<FileItem>;
    path: Path;
    file: Option<string>;
    items: FileItem[] = [];
    pathHistory: { [path: string]: Option<string> };
    inActions: boolean = false;
    keepAlive: boolean = false;
    autoCompletion?: AutoCompletion;

    actionsButton: QuickInputButton = {
        iconPath: new ThemeIcon("ellipsis"),
        tooltip: "Actions on selected file",
    };
    stepOutButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-left"),
        tooltip: "Step out of folder",
    };
    stepInButton: QuickInputButton = {
        iconPath: new ThemeIcon("arrow-right"),
        tooltip: "Step into folder",
    };

    constructor(path: Path, file: Option<string>) {
        this.path = path;
        this.file = file;
        this.pathHistory = { [this.path.id]: this.file };
        this.current = vscode.window.createQuickPick();
        this.current.buttons = [this.actionsButton, this.stepOutButton, this.stepInButton];
        this.current.placeholder = "Preparing the file list...";
        this.current.onDidHide(() => {
            if (!this.keepAlive) {
                this.dispose();
            }
        });
        this.current.onDidAccept(this.onDidAccept.bind(this));
        this.current.onDidChangeValue(this.onDidChangeValue.bind(this));
        this.current.onDidTriggerButton(this.onDidTriggerButton.bind(this));
        this.update().then(() => {
            this.current.placeholder = "Type a file name here to search or open a new file";
            this.current.busy = false;
        });
    }

    dispose() {
        setContext(false);
        this.current.dispose();
        active = None;
    }

    hide() {
        this.current.hide();
        setContext(false);
    }

    show() {
        setContext(true);
        this.current.show();
    }

    defaultOptions() {
        return [
            action(`$(new-file) Create file: ${this.current.value}`, Action.NewFile, this.current.value),
            action(`$(new-folder) Create folder: ${this.current.value}`, Action.NewFolder, this.current.value)
        ];
    }

    async update() {
        this.show();
        this.current.busy = true;
        this.current.title = this.path.fsPath;

        if (!this.inActions) {
            this.current.value = "";
        }

        const stat = (await Result.try(vscode.workspace.fs.stat(this.path.uri))).unwrap();

        let defaultItems: any = [];

        // we have a search value
        if (this.current.value !== "") {
            defaultItems = this.defaultOptions();
        }

        // selection is file + showing actions
        if (
            stat &&
            this.inActions &&
            (stat.type & FileType.File) === FileType.File
        ) {
            this.items = [];

            const selectedFile = new Path(this.path.uri).pop().unwrap();

            if (this.current.value && this.current.value !== selectedFile) {
                this.items.push(...defaultItems);
            }

            this.items.push(
                ...[
                    action(`$(file) Open file '${selectedFile}'`, Action.OpenFile),
                    action(`$(split-horizontal) Open file '${selectedFile}' to the side`, Action.OpenFileBeside),
                    action(`$(edit) Rename file '${selectedFile}'`, Action.RenameFile),
                    action(`$(trash) Delete file '${selectedFile}'`, Action.DeleteFile),
                ]
            );

            this.current.items = this.items;
        }
        // selection is directory + showing actions
        else if (
            stat &&
            this.inActions &&
            (stat.type & FileType.Directory) === FileType.Directory
        ) {
            this.items = [];

            const selectedDir = new Path(this.path.uri).pop().unwrap();

            if (this.current.value && this.current.value !== selectedDir) {
                this.items.push(...defaultItems);
            }

            // if we have an existing folder
            if (this.current.activeItems.length) {
                this.items.push(
                    ...[
                        action(`$(folder-opened) Open folder in current window '${selectedDir}'`, Action.OpenFolder),
                        action(`$(folder-opened) Open folder in a new window '${selectedDir}'`, Action.OpenFolderInNewWindow),
                        action(`$(edit) Rename folder '${selectedDir}'`, Action.RenameFile),
                        action(`$(trash) Delete folder '${selectedDir}'`, Action.DeleteFile),
                    ]
                );
            }

            this.current.items = this.items;
        }
        // selection is directory
        else if (
            stat &&
            (stat.type & FileType.Directory) === FileType.Directory
        ) {
            const records = await vscode.workspace.fs.readDirectory(this.path.uri);
            records.sort(fileRecordCompare);

            let items = records.map((entry) => new FileItem(entry));

            if (config(ConfigItem.HideIgnoreFiles)) {
                const rules = await Rules.forPath(this.path);
                items = rules.filter(this.path, items);
            }

            if (config(ConfigItem.RemoveIgnoredFiles)) {
                items = items.filter((item) => item.alwaysShow);
            }

            this.items = items;
            this.current.items = items;
            this.current.activeItems = this.file.isSome()
                ? items.filter((item) => this.file.contains(item.name))
                : [items[0]];
        }
        // selection is file
        else {
            if (this.current.value) {
                this.items = this.defaultOptions();
            }

            this.current.items = this.items;
        }

        this.current.busy = false;
    }

    onDidChangeValue(value: string, isAutoComplete = false) {
        if (this.inActions && value) {
            return;
        }

        if (!isAutoComplete) {
            this.autoCompletion = undefined;
        }

        if (value === "") {
            this.inActions = false
            this.update()
        } else {
            endsWithPathSeparator(value).match(
                (path) => {
                    if (path === "~") {
                        this.stepIntoFolder(Path.fromFilePath(OS.homedir()));
                    } else if (path === "..") {
                        this.stepOut();
                    } else {
                        this.stepIntoFolder(this.path.append(path));
                    }
                },
                () => {
                    if (!this.inActions) {
                        this.current.items = this.items.filter((item) => item.name.toLowerCase().startsWith(value.toLowerCase()));

                        if (!this.current.items.length) {
                            this.current.items = this.defaultOptions()
                        }
                    }

                    this.inActions = false
                }
            );
        }
    }

    onDidTriggerButton(button: QuickInputButton) {
        if (button === this.stepInButton) {
            this.stepIn();
        } else if (button === this.stepOutButton) {
            this.stepOut();
        } else if (button === this.actionsButton) {
            this.actions();
        }
    }

    activeItem(): Option<FileItem> {
        return new Option(this.current.activeItems[0]);
    }

    async stepIntoFolder(folder: Path) {
        if (!this.path.equals(folder)) {
            this.path = folder;
            this.file = None;

            await this.update();
        }
    }

    async stepIn() {
        this.activeItem().ifSome(async (item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (item.fileType !== undefined) {
                if ((item.fileType & FileType.Directory) === FileType.Directory) {
                    await this.stepIntoFolder(this.path.append(item.name));
                }
                else if ((item.fileType & FileType.File) === FileType.File) {
                    this.path.push(item.name);
                    this.file = None;
                    this.inActions = true;

                    await this.update();
                }
            }
        });
    }

    async stepOut() {
        this.inActions = false;

        if (!this.path.atTop()) {
            this.pathHistory[this.path.id] = this.activeItem().map((item) => item.name);
            this.file = this.path.pop();

            await this.update();
        }
    }

    async actions() {
        if (this.inActions) {
            const stat = (await Result.try(vscode.workspace.fs.stat(this.path.uri))).unwrap();
            if (stat && (stat.type & FileType.File) === FileType.File) {
                return this.stepOut()
            }

            this.inActions = false;

            return this.update();
        }

        this.inActions = true;
        this.file = None;

        await this.activeItem().match(
            async (item) => {
                this.path.push(item.name);
            },
            async () => {}
        );

        await this.update();
    }

    tabCompletion(tabNext: boolean) {
        if (this.inActions || !this.current.value) {
            return;
        }

        if (this.autoCompletion) {
            const length = this.autoCompletion.items.length;
            const step = tabNext ? 1 : -1;
            this.autoCompletion.index = (this.autoCompletion.index + length + step) % length || 0;
        } else {
            const items = this.items.filter((i) =>
                i.name.toLowerCase().startsWith(this.current.value.toLowerCase())
            );
            this.autoCompletion = {
                index: tabNext ? 0 : items.length - 1,
                items,
            };
        }

        const newIndex = this.autoCompletion.index;
        const length = this.autoCompletion.items.length;

        if (newIndex < length) {
            // This also checks out when items is empty
            const item = this.autoCompletion.items[newIndex];
            this.current.value = item.name;

            if (length === 1 && item.fileType === FileType.Directory) {
                return this.onDidAccept();
            }

            this.onDidChangeValue(this.current.value, true);
        }
    }

    onDidAccept() {
        this.autoCompletion = undefined;

        this.activeItem().ifSome((item) => {
            if (item.action !== undefined) {
                this.runAction(item);
            } else if (
                item.fileType !== undefined &&
                (item.fileType & FileType.Directory) === FileType.Directory
            ) {
                this.stepIn();
            } else {
                this.openFile(this.path.append(item.name).uri);
            }
        });
    }

    openFile(uri: Uri, column: ViewColumn = ViewColumn.Active) {
        this.dispose();
        vscode.workspace
            .openTextDocument(uri)
            .then((doc) => vscode.window.showTextDocument(doc, column));
    }

    async shouldGoUp(pathUri) {
        return (await pathUri.isFile() || await pathUri.isDir()) &&
                this.current.items.length > this.defaultOptions().length
    }

    async runAction(item: FileItem) {
        switch (item.action) {
            case Action.NewFolder: {
                let pathUri: any = this.path

                if (await this.shouldGoUp(pathUri)) {
                    pathUri = pathUri.parent().append(item.name).uri;
                } else {
                    pathUri = pathUri.append(item.name).uri;
                }

                await vscode.workspace.fs.createDirectory(pathUri);
                this.path = new Path(pathUri);
                this.inActions = true

                await this.update();
                break;
            }
            case Action.NewFile: {
                let pathUri: any = this.path

                if (await this.shouldGoUp(pathUri)) {
                    pathUri = pathUri.parent().append(item.name).uri;
                } else {
                    pathUri = pathUri.append(item.name).uri;
                }

                this.openFile(pathUri.with({ scheme: "untitled" }));

                break;
            }
            case Action.OpenFile: {
                const path = this.path.clone();

                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }

                this.openFile(path.uri);

                break;
            }
            case Action.OpenFileBeside: {
                const path = this.path.clone();

                if (item.name && item.name.length > 0) {
                    path.push(item.name);
                }

                this.openFile(path.uri, ViewColumn.Beside);

                break;
            }
            case Action.RenameFile: {
                this.keepAlive = true;
                this.hide();
                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;
                const fileName = this.path.pop().unwrapOrElse(() => {
                    throw new Error("Can't rename an empty file name!");
                });

                const fileType = isDir ? "folder" : "file";
                const workspaceFolder = this.path.getWorkspaceFolder().map((wsf) => wsf.uri);
                const relPath = workspaceFolder
                    .andThen((workspaceFolder) => new Path(uri).relativeTo(workspaceFolder))
                    .unwrapOr(fileName);

                const extension = OSPath.extname(relPath);
                const startSelection = relPath.length - fileName.length;
                const endSelection = startSelection + (fileName.length - extension.length);
                const result = await vscode.window.showInputBox({
                    prompt: `Enter the new ${fileType} name`,
                    value: relPath,
                    valueSelection: [startSelection, endSelection],
                });

                this.file = Some(fileName);

                if (result !== undefined) {
                    const newUri = workspaceFolder.match(
                        (workspaceFolder) => Uri.joinPath(workspaceFolder, result),
                        () => Uri.joinPath(this.path.uri, result)
                    );

                    if ((await Result.try(vscode.workspace.fs.rename(uri, newUri))).isOk()) {
                        this.file = Some(OSPath.basename(result));
                    } else {
                        vscode.window.showErrorMessage(
                            `Failed to rename ${fileType} "${fileName}"`
                        );
                    }
                }

                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();

                break;
            }
            case Action.DeleteFile: {
                this.keepAlive = true;
                this.hide();

                const uri = this.path.uri;
                const stat = await vscode.workspace.fs.stat(uri);
                const isDir = (stat.type & FileType.Directory) === FileType.Directory;
                const fileName = this.path.pop().unwrapOrElse(() => {
                    throw new Error("Can't delete an empty file name!");
                });

                const fileType = isDir ? "folder" : "file";
                const goAhead = `$(trash) Delete the ${fileType} "${fileName}"`;
                const result = await vscode.window.showQuickPick(["$(close) Cancel", goAhead], {});

                if (result === goAhead) {
                    const delOp = await Result.try(
                        vscode.workspace.fs.delete(uri, { recursive: isDir, useTrash: true })
                    );

                    if (delOp.isErr()) {
                        vscode.window.showErrorMessage(
                            `Failed to delete ${fileType} "${fileName}"`
                        );
                    }
                }

                this.show();
                this.keepAlive = false;
                this.inActions = false;
                this.update();

                break;
            }
            case Action.OpenFolder: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri);

                break;
            }
            case Action.OpenFolderInNewWindow: {
                vscode.commands.executeCommand("vscode.openFolder", this.path.uri, true);

                break;
            }
            default:
                throw new Error(`Unhandled action ${item.action}`);
        }
    }
}

async function init() {
    const document = vscode.window.activeTextEditor?.document;
    const uriSchemeMap: any = config(ConfigItem.UriSchemeUriCommandMap) || {};
    let workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    let path = new Path(workspaceFolder?.uri || Uri.file(OS.homedir()));
    let file: Option<string> = None;

    if (document && uriSchemeMap.hasOwnProperty(document.uri.scheme)) {
        const uri: vscode.Uri | undefined = await vscode.commands.executeCommand(uriSchemeMap[document.uri.scheme]);

        if (uri) {
            path = new Path(uri);
        }
    } else if (document && !document.isUntitled) {
        path = new Path(document.uri);
        file = path.pop();
    }

    active = Some(new FileBrowser(path, file));
    setContext(true);
}

export function activate(context: vscode.ExtensionContext) {
    setContext(false);

    context.subscriptions.push(
        vscode.commands.registerCommand("quick-file-browser.open", init)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("quick-file-browser.stepIn", () =>
            active.ifSome((active) => active.stepIn())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("quick-file-browser.stepOut", () =>
            active.ifSome((active) => active.stepOut())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("quick-file-browser.actions", () =>
            active.ifSome((active) => active.actions())
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("quick-file-browser.tabNext", () =>
            active.ifSome((active) => active.tabCompletion(true))
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("quick-file-browser.tabPrev", () =>
            active.ifSome((active) => active.tabCompletion(false))
        )
    );
}

export function deactivate() { }
