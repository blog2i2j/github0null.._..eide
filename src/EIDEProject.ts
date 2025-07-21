/*
    MIT License

    Copyright (c) 2019 github0null

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as NodePath from 'path';
import * as events from 'events';
import * as ini from 'ini';
import * as os from 'os';
import * as yaml from 'yaml';
import * as child_process from 'child_process';

import {
    CppToolsApi, Version, CustomConfigurationProvider, getCppToolsApi,
    SourceFileConfigurationItem, WorkspaceBrowseConfiguration
} from 'vscode-cpptools';

import { File } from '../lib/node-utility/File';
import { FileWatcher } from '../lib/node-utility/FileWatcher';
import { KeilParser } from './KeilXmlParser';
import { ResManager } from './ResManager';
import { SevenZipper, SevenZipUnzipExcludeList } from './Compress';
import {
    BuilderOptions,
    ConfigMap, FileGroup,
    ProjectConfiguration, ProjectConfigData, WorkspaceConfiguration,
    CreateOptions,
    ProjectConfigEvent, ProjectFileGroup, FileItem, EIDE_CONF_VERSION, ProjectTargetInfo, VirtualFolder, VirtualFile, CppConfigItem, ProjectBaseApi, ProjectType, BuilderConfigData, MAPPED_KEYS_IN_TARGET_INFO
} from './EIDETypeDefine';
import { ToolchainName, IToolchian, ToolchainManager } from './ToolchainManager';
import { GlobalEvent } from './GlobalEvents';
import { ArrayDelRepetition } from '../lib/node-utility/Utility';
import { ExceptionToMessage, newMessage } from './Message';
import { PackageManager, ComponentUpdateItem, ComponentUpdateType } from './PackageManager';
import { HexUploaderType } from './HexUploader';
import { WebPanelManager } from './WebPanelManager';
import { DependenceManager } from './DependenceManager';
import * as platform from './Platform';
import { md5, copyObject, compareVersion, isGccFamilyToolchain, deepCloneObject, notifyReloadWindow, copyAndMakeObjectKeysToLowerCase, runShellCommand, execInternalCommand } from './utility';
import { ResInstaller } from './ResInstaller';
import {
    view_str$prompt$filesOptionsComment,
    view_str$prompt$reloadForOldProject,
    view_str$prompt$not_found_compiler, view_str$operation$name_can_not_be_blank,
    view_str$operation$name_can_not_have_invalid_char,
    view_str$prompt$project_is_opened_by_another,
    WARNING,
    view_str$prompt$chipPkgNotCompateThisVersion,
    view_str$prompt$userCanceledOperation,
    continue_text,
    cancel_text,
} from './StringTable';
import { SettingManager } from './SettingManager';
import { ExeCmd } from '../lib/node-utility/Executable';
import { jsonc } from 'jsonc';
import * as iconv from 'iconv-lite';
import * as globmatch from 'micromatch'
import { EventData, CurrentDevice, ArmBaseCompileConfigModel, ArmBaseCompileData } from './EIDEProjectModules';
import * as FileLock from '../lib/node-utility/FileLock';
import { CompilerCommandsDatabaseItem, CodeBuilder } from './CodeBuilder';
import { xpackRequireDevTools } from './XpackDevTools';

export class CheckError extends Error {
}

export interface CheckResult {
    success: boolean;
    err?: CheckError;
}

//==========================================

interface SourceProvider {

    getFileGroups(): FileGroup[];

    notifyUpdateFile(path: string): void;

    notifyUpdateFolder(path: string): void;

    forceUpdateAllFolders(): void;
}

export interface FolderInfo {
    displayName: string;
    needUpdate: boolean;
    fileWatcher: FileWatcher;
}

interface SourceRootInfo extends FolderInfo {
    isValid: () => boolean;
    fileWatcher: FileWatcher;
    fileGroups: ProjectFileGroup[];
    incList: string[];
    needUpdate: boolean;
    refreshTimeout?: NodeJS.Timeout;
}

type SourceChangedEvent = 'folderChanged' | 'dataChanged' | 'fileStatusChanged' | 'folderStatusChanged';

export class VirtualSource implements SourceProvider {

    public static rootName = '<virtual_root>';

    private project: AbstractProject;
    private config: ProjectConfigData<any>;
    private _event: events.EventEmitter;

    on(event: 'dataChanged', listener: (event: SourceChangedEvent) => void): void;
    on(event: any, listener: (arg: any) => void): void {
        this._event.on(event, listener);
    }

    private emit(event: 'dataChanged', e: SourceChangedEvent): void;
    private emit(event: any, arg?: any): void {
        this._event.emit(event, arg);
    }

    constructor(prj: AbstractProject) {
        this.project = prj;
        this.config = <any>null;
        this._event = new events.EventEmitter();
    }

    public static isVirtualPath(path: string): boolean {
        return path.startsWith(VirtualSource.rootName);
    }

    public static toAbsPath(...paths: string[]): string {
        if (paths.length == 0) return VirtualSource.rootName;
        return VirtualSource.rootName + '/' + paths.join('/');
    }

    public getRoot(): VirtualFolder {
        return this.config.virtualFolder;
    }

    private getFolderByName(vFolder: VirtualFolder, name: string): VirtualFolder | undefined {
        for (const folder of vFolder.folders) {
            if (folder.name === name) {
                return folder;
            }
        }
    }

    traverse(func: (folderInfo: { path: string, folder: VirtualFolder }) => void) {

        const folderStack: { path: string, folder: VirtualFolder }[] = [];

        // put root folders
        const rootFolder = this.getFolder();
        if (rootFolder) {
            folderStack.push({
                path: rootFolder.name,
                folder: rootFolder
            });
        }

        let curFolder: { path: string, folder: VirtualFolder };

        while (folderStack.length > 0) {
            curFolder = <any>folderStack.pop();
            func(curFolder);
            for (const vFolder of curFolder.folder.folders) {
                folderStack.push({
                    path: `${curFolder.path}/${vFolder.name}`,
                    folder: vFolder
                });
            }
        }
    }

    // load

    load(notEmitEvt?: boolean) {
        this.config = this.project.GetConfiguration().config;
        // refresh all
        if (!notEmitEvt) { this.forceUpdateAllFolders(); }
    }

    // get

    getFolder(vpath?: string): VirtualFolder | undefined {
        if (vpath === undefined || vpath === VirtualSource.rootName) {
            return this.getRoot();
        } else {
            const nameList = vpath.split('/');
            let cur_folder: VirtualFolder = {
                name: '/',
                files: [],
                folders: [this.getRoot()]
            };
            for (const name of nameList) {
                const next = this.getFolderByName(cur_folder, name);
                if (next) {
                    cur_folder = next;
                } else {
                    return undefined;
                }
            }
            return cur_folder;
        }
    }

    getFile(vpath: string): VirtualFile | undefined {
        const vFolder = this.getFolder(NodePath.dirname(vpath));
        if (vFolder) {
            const fileName = NodePath.basename(vpath);
            const index = vFolder.files.findIndex((file) => NodePath.basename(file.path) == fileName);
            if (index !== -1) {
                return vFolder.files[index];
            }
        }
    }

    // implement

    getFileGroups(): FileGroup[] {

        const result: FileGroup[] = [];

        this.traverse((folderInfo) => {
            result.push({
                name: folderInfo.path,
                disabled: this.project.isExcluded(folderInfo.path) || undefined,
                files: folderInfo.folder.files.map((vFile) => {
                    const file = new File(this.project.ToAbsolutePath(vFile.path));
                    const vFilePath = `${folderInfo.path}/${file.name}`;
                    return {
                        file: file,
                        disabled: this.project.isExcluded(vFilePath) || undefined
                    };
                })
            });
        });

        return result;
    }

    notifyUpdateFile(virtualPath: string): void {

        if (!virtualPath.startsWith(VirtualSource.rootName)) {
            return; // if it's not a virtual file, exit
        }

        this.emit('dataChanged', 'fileStatusChanged');
    }

    notifyUpdateFolder(virtualPath: string): void {

        if (!virtualPath.startsWith(VirtualSource.rootName)) {
            return; // if it's not a virtual folder, exit
        }

        const vFolder = this.getFolder(virtualPath);
        if (vFolder) {
            this.emit('dataChanged', 'folderStatusChanged');
        }
    }

    forceUpdateAllFolders(): void {
        this.emit('dataChanged', 'folderStatusChanged');
    }

    // set

    addFile(vfolder_path: string, fspath: string): VirtualFile | undefined {
        const folder = this.getFolder(vfolder_path);
        if (folder) {
            const vFilePath = `${vfolder_path}/${NodePath.basename(fspath)}`;
            if (this.getFile(vFilePath) === undefined) { // file is not existed, add it
                const vFile: VirtualFile = { path: this.project.toRelativePath(fspath) };
                folder.files.push(vFile);
                this.emit('dataChanged', 'folderChanged');
                return vFile;
            }
        }
    }

    addFiles(folder_path: string, pathList: string[]): VirtualFile[] | undefined {

        const folder = this.getFolder(folder_path);
        if (folder) {

            const doneList: VirtualFile[] = [];

            for (const abspath of pathList) {
                const vFilePath = `${folder_path}/${NodePath.basename(abspath)}`;
                if (this.getFile(vFilePath) === undefined) { // file is not existed, add it
                    const vFile: VirtualFile = { path: this.project.toRelativePath(abspath) };
                    folder.files.push(vFile);
                    doneList.push(vFile);
                }
            }

            if (doneList.length > 0) {
                this.emit('dataChanged', 'folderChanged');
            }

            return doneList;
        }
    }

    removeFile(vpath: string): VirtualFile | undefined {
        const basename = NodePath.basename(vpath);
        const vFolder = this.getFolder(NodePath.dirname(vpath));
        if (vFolder) {
            const index = vFolder.files.findIndex((f) => NodePath.basename(f.path) == basename);
            if (index !== -1) {
                const rmFile = vFolder.files.splice(index, 1)[0];
                this.emit('dataChanged', 'folderChanged');
                return rmFile;
            }
        }
    }

    addFolder(name: string, parent_path?: string): VirtualFolder | undefined {
        const vFolder = this.getFolder(parent_path);
        if (vFolder) {
            const index = vFolder.folders.findIndex((f) => { return f.name === name; });
            if (index === -1) {
                //const vFolderPath = `${parent_path || VirtualSource.rootName}/${name}`;
                const nFolder: VirtualFolder = { name: name, files: [], folders: [] };
                vFolder.folders.push(nFolder);
                this.emit('dataChanged', 'folderChanged');
                return nFolder;
            }
        }
    }

    insertFolder(parentvPath: string, nFolder: VirtualFolder): string | undefined {
        const vFolder = this.getFolder(parentvPath);
        if (vFolder) {
            const index = vFolder.folders.findIndex((f) => f.name == nFolder.name);
            if (index === -1) {
                vFolder.folders.push(nFolder);
                this.emit('dataChanged', 'folderChanged');
                return `${parentvPath}/${nFolder.name}`;
            }
        }
    }

    removeFolder(path: string): VirtualFolder | undefined {
        const name = NodePath.basename(path);
        const vFolder = this.getFolder(NodePath.dirname(path));
        if (vFolder) {
            const index = vFolder.folders
                .findIndex((f) => { return f.name === name; });
            if (index !== -1) {
                const rmFolder = vFolder.folders.splice(index, 1)[0];
                this.emit('dataChanged', 'folderChanged');
                return rmFolder;
            }
        }
    }

    isFolder(path: string): boolean {
        return this.getFolder(path) !== undefined;
    }

    renameFolder(vpath: string, newName: string): VirtualFolder | undefined {
        const vFolder = this.getFolder(vpath);
        if (vFolder) {
            vFolder.name = newName;
            this.emit('dataChanged', 'folderChanged');
            return vFolder;
        }
    }
}

class SourceRootList implements SourceProvider {

    private project: AbstractProject;
    private _event: events.EventEmitter;

    // src folder info
    //      key: relative path
    //      val: SourceRootInfo
    private srcFolderMaps: Map<string, SourceRootInfo>;

    private isAutoSearchIncPath: boolean = false;
    private isAutoSearchObjFile: boolean = false;

    on(event: 'dataChanged', listener: (event: SourceChangedEvent) => void): void;
    on(event: any, listener: (arg: any) => void): void {
        this._event.on(event, listener);
    }

    constructor(_project: AbstractProject) {
        this.project = _project;
        this._event = new events.EventEmitter();
        this.srcFolderMaps = new Map();
        FileWatcher.on('rename', f => this.onFileRenamed(f));
    }

    isAutoSearchObjectFile(): boolean {
        return this.isAutoSearchObjFile;
    }

    load(notEmitEvt?: boolean) {

        this.isAutoSearchIncPath = SettingManager.GetInstance().isAutoSearchIncludePath();
        this.isAutoSearchObjFile = SettingManager.GetInstance().isAutoSearchObjFile();

        this.DisposeAll();

        // load source folders from filesystem
        const srcFolders = this.project.GetConfiguration().config.srcDirs;
        srcFolders.forEach((path) => {
            const f = new File(path);
            this._add(f);
        });

        // update all
        for (const info of this.srcFolderMaps.values()) {
            this.updateFolder(info);
        }

        if (!notEmitEvt) { this.emit('dataChanged', 'dataChanged'); }
    }

    private _add(dir: File): SourceRootInfo {
        const key: string = this.project.toRelativePath(dir.path);
        const watcher = platform.createSafetyFileWatcher(dir, true);
        watcher.on('error', (err) => GlobalEvent.log_warn(err));
        const sourceInfo = this.newSourceInfo(key, watcher);
        this.srcFolderMaps.set(key, sourceInfo);
        return sourceInfo;
    }

    add(absPath: string): boolean {
        const dir = new File(absPath);
        const sourceInfo = this._add(dir);
        this.updateFolder(sourceInfo);
        return true;
    }

    remove(absPath: string): boolean {
        const key = this.project.toRelativePath(absPath);
        return this.removeByKey(key);
    }

    DisposeAll() {

        for (const info of this.srcFolderMaps.values()) {
            info.fileWatcher.Close();
        }

        this.srcFolderMaps.clear();
    }

    notifyUpdateFolder(absPath: string) {

        // it's a root folder ?

        for (const rInfo of this.srcFolderMaps.values()) {
            if (rInfo.fileWatcher.file.path == absPath) {
                this.updateFolder(rInfo);
                this.emit('dataChanged', 'folderStatusChanged');
                return;
            }
        }

        // it's a sub folder ?

        const targetDir = NodePath.dirname(absPath);

        const rootSrcUpdateList = Array.from(this.srcFolderMaps.values())
            .filter((info) => {
                return File.isSubPathOf(info.fileWatcher.file.path, targetDir);
            });

        if (rootSrcUpdateList.length > 0) {

            for (const rootInfo of rootSrcUpdateList) {
                this.updateFolder(rootInfo, [targetDir]);
            }

            this.emit('dataChanged', 'folderStatusChanged');
        }
    }

    notifyUpdateFile(absPath: string) {

        const dir = NodePath.dirname(absPath);

        const updateList = Array.from(this.srcFolderMaps.values())
            .filter((info) => {
                return File.isSubPathOf(info.fileWatcher.file.path, dir);
            });

        if (updateList.length > 0) {

            updateList.forEach((info) => {
                for (const group of info.fileGroups) {
                    const index = group.files.findIndex((file) => { return file.file.path === absPath; });
                    if (index !== -1) {
                        group.files[index].disabled = this.project.isExcluded(absPath) || undefined;
                    }
                }
            });

            this.emit('dataChanged', 'fileStatusChanged');
        }
    }

    getRootFolderList(): FolderInfo[] {
        return Array.from(this.srcFolderMaps.values());
    }

    getIncludeList(): string[] {
        const res: string[] = [];
        for (const info of this.srcFolderMaps.values()) {
            for (const include of info.incList) {
                res.push(include);
            }
        }
        return res;
    }

    getFileGroups(): ProjectFileGroup[] {
        const res: ProjectFileGroup[] = [];
        for (const info of this.srcFolderMaps.values()) {
            for (const group of info.fileGroups) {
                res.push(group);
            }
        }
        return res;
    }

    isIncludes(abspath: string): boolean {

        if (!File.isAbsolute(abspath)) {
            abspath = this.project.toAbsolutePath(abspath);
        }

        const unixPath = File.ToUnixPath(abspath);

        for (const rootInfo of this.srcFolderMaps.values()) {
            const unixRootPath = File.ToUnixPath(rootInfo.fileWatcher.file.path);
            const unixRootRealPath = File.ToUnixPath(platform.realpathSync(rootInfo.fileWatcher.file.path));
            if (unixPath.startsWith(unixRootPath) ||
                unixPath.startsWith(unixRootRealPath)) {
                return true;
            }
        }

        return false;
    }

    forceUpdateAllFolders() {
        for (const info of this.srcFolderMaps.values()) {
            this.updateFolder(info);
        }
        this.emit('dataChanged', 'folderChanged');
    }

    forceUpdateFolder(rePath: string) {
        const rootInfo = this.srcFolderMaps.get(rePath);
        if (rootInfo) {
            this.updateFolder(rootInfo);
            this.emit('dataChanged', 'folderChanged');
        }
    }

    // -- private region

    private emit(event: 'dataChanged', e: SourceChangedEvent): void;
    private emit(event: any, arg?: any): void {
        this._event.emit(event, arg);
    }

    private newSourceInfo(displayName: string, watcher: FileWatcher): SourceRootInfo {
        return {
            displayName: displayName,
            fileWatcher: watcher,
            isValid: () => watcher.file.IsDir(),
            needUpdate: false,
            fileGroups: [],
            incList: []
        };
    }

    private disposeWatcher(key: string): void {
        this.srcFolderMaps.get(key)?.fileWatcher.Close();
    }

    private removeByKey(key: string): boolean {
        this.disposeWatcher(key);
        return this.srcFolderMaps.delete(key);
    }

    private onFileRenamed(targetFile: File) {

        const key = this.project.toRelativePath(targetFile.path);

        // it's a root sources folder ?
        const rootInfo = this.srcFolderMaps.get(key);
        if (rootInfo) {

            // this folder's file watcher is invalid, dispose it
            this.disposeWatcher(key);
            this.emit('dataChanged', 'folderStatusChanged');

            // try update resources of it
            if (rootInfo.refreshTimeout) {
                rootInfo.refreshTimeout.refresh();
            } else {
                rootInfo.refreshTimeout = setTimeout((folderInfo: SourceRootInfo) => {
                    if (folderInfo.refreshTimeout) {
                        folderInfo.refreshTimeout = undefined;
                        this.updateFolder(folderInfo);
                        this.emit('dataChanged', 'folderChanged');
                    }
                }, 200, rootInfo);
            }
        }

        // it's a text file, or a sub folder, or others
        else {

            const targetDir = NodePath.dirname(targetFile.path);

            const rootSrcUpdateList = Array.from(this.srcFolderMaps.values())
                .filter((info) => File.isSubPathOf(info.fileWatcher.file.path, targetDir));

            if (rootSrcUpdateList.length > 0) {

                rootSrcUpdateList.forEach((rootInfo) => {
                    if (rootInfo.refreshTimeout) {
                        rootInfo.refreshTimeout.refresh();
                    } else {
                        rootInfo.refreshTimeout = setTimeout((folderInfo: SourceRootInfo) => {
                            if (folderInfo.refreshTimeout) {
                                folderInfo.refreshTimeout = undefined;
                                this.updateFolder(rootInfo, [targetDir]);
                                this.emit('dataChanged', 'folderChanged');
                            }
                        }, 200, rootInfo);
                    }
                });
            }
        }
    }

    private updateFolder(rootFolderInfo: SourceRootInfo, targetFolderList?: string[]) {

        console.log(`[cl.eide] update source folder: '${rootFolderInfo.fileWatcher.file.path}' (${targetFolderList?.join(',')})`);

        const rootFolder = rootFolderInfo.fileWatcher.file;
        const folderStack: File[] = [];

        // exclude some root folder when add files to custom include paths
        const disableInclude: boolean = AbstractProject.excludeIncSearchList.includes(
            this.project.toRelativePath(rootFolder.path)
        );

        const sourceFilter = this.isAutoSearchObjFile ?
            AbstractProject.getSourceFileFilter() : AbstractProject.getSourceFileFilterWithoutObj();
        const fileFilter = AbstractProject.getFileFilters();

        // if source root have no watcher, watch it !
        if (rootFolderInfo.isValid() && !rootFolderInfo.fileWatcher.IsWatched()) {
            try {
                rootFolderInfo.fileWatcher.Watch();
            } catch (error) {
                GlobalEvent.log_error(<Error>error);
            }
        }

        if (targetFolderList) { // only update target folders
            targetFolderList = targetFolderList.map((path) => this.project.ToAbsolutePath(path));
            targetFolderList.forEach((dir) => { // rm old record of these folders
                rootFolderInfo.incList = rootFolderInfo.incList.filter(incPath => !File.isSubPathOf(dir, incPath));
                rootFolderInfo.fileGroups = rootFolderInfo.fileGroups.filter(fGroup => !File.isSubPathOf(dir, fGroup.dir.path));
                folderStack.push(new File(dir));
            });
        } else { // update root folder
            rootFolderInfo.incList = [];
            rootFolderInfo.fileGroups = [];
            folderStack.push(rootFolder);
        }

        rootFolderInfo.needUpdate = false;

        try {

            while (folderStack.length > 0) {

                const cFolder = <File>folderStack.pop();
                const isSourceRoot = cFolder.path === rootFolder.path;

                if (!cFolder.IsDir())
                    continue; // skip not-existed folder

                if (cFolder.name.startsWith('.') && !isSourceRoot)
                    continue; // skip sub '.xxx' folders, but not root folder

                const fileList = cFolder.GetList(fileFilter, File.EXCLUDE_ALL_FILTER);
                if (fileList.length > 0) {

                    // filter source file and add to file group
                    const srcFiles = fileList.filter((file) => {
                        return sourceFilter.some((regexp) => {
                            return regexp.test(file.name);
                        });
                    });

                    const isFolderExcluded = this.project.isExcluded(cFolder.path) || undefined;

                    if (srcFiles.length > 0) {

                        const group: ProjectFileGroup = {
                            name: cFolder.name,
                            dir: cFolder,
                            disabled: isFolderExcluded,
                            isRoot: isSourceRoot,
                            files: []
                        };

                        for (const _file of srcFiles) {
                            group.files.push({
                                file: _file,
                                // we do not need use 'isFolderExcluded' condition, because we
                                // will exclude thi group before exclude this file
                                disabled: this.project.isExcluded(_file.path) || undefined
                            });
                        }

                        rootFolderInfo.fileGroups.push(group);
                    }

                    // add to include folders
                    if (this.isAutoSearchIncPath && !disableInclude && !isFolderExcluded) {
                        rootFolderInfo.incList.push(cFolder.path);
                    }
                }

                // push subfolders
                cFolder.GetList(File.EXCLUDE_ALL_FILTER)
                    .filter((folder) => !AbstractProject.excludeDirFilter.test(folder.name))
                    .forEach((folder) => folderStack.push(folder));
            }

        } catch (error) {
            rootFolderInfo.needUpdate = true; // set need update flag
            GlobalEvent.log_warn(error);
        }
    }
}

///////////////////////////////////////////////

export interface BaseProjectInfo {
    rootFolder: File;
    workspaceFile: File;
    prjConfig: ProjectConfiguration<any>;
}

export interface SourceExtraMemoryAssignCfg {
    RO?: string;
    RW?: string;
    ZI?: string;
}

export interface SourceExtraCompilerOptionsCfg {
    files?: { [key: string]: string };
    virtualPathFiles?: { [key: string]: string };
    alwaysBuildSourceFiles?: string[];
    memoryAssign?: { [key: string]: SourceExtraMemoryAssignCfg };
}

export interface SourceFileOptions {
    version: string;
    options: { [target: string]: SourceExtraCompilerOptionsCfg };
};

export type DataChangeType = 'pack' | 'dependence' | 'compiler' | 'uploader' | 'files';
export const EIDE_FILE_OPTION_VERSION = '2.1'

export abstract class AbstractProject implements CustomConfigurationProvider, ProjectBaseApi {

    static readonly workspaceSuffix = '.code-workspace';
    static readonly vsCodeDir = '.vscode';
    static readonly EIDE_DIR = '.eide';

    static readonly cppConfigName = 'c_cpp_properties.json';
    static readonly prjConfigName = 'eide.json';

    static readonly importerWarningBaseName = 'importer.warning.txt';

    // avaliable source files
    static readonly headerFilter: RegExp = /\.(?:h|hxx|hpp|inc)$/i;
    static readonly cppfileFilter: RegExp = /\.(?:c|cpp|c\+\+|cc|cxx)$/i;
    static readonly libFileFilter: RegExp = /\.(?:lib|a|o|obj)$/i;
    static readonly asmfileFilter: RegExp = /\.(?:s|asm|a51)$/i;

    // this folder list will be excluded when search include path
    static readonly excludeIncSearchList: string[] = [];

    // this folder will be excluded when search source path
    static readonly excludeDirFilter: RegExp = /^\./;

    // to show output files
    static readonly buildOutputMatcher: RegExp = /\.(?:elf|axf|out|sm8|a|lib|hex|ihx|bin|s19|s37|sct|icf|ld[s]?|map|map\.view|lst|lnp|params)$/i;

    //-------

    protected _event: events.EventEmitter;
    protected configMap: ConfigMap;
    protected packManager: PackageManager;
    protected dependenceManager: DependenceManager;
    protected rootDir: File | undefined;
    protected eideDir: File | undefined;
    protected toolchain: IToolchian | undefined;
    protected prevToolchain: IToolchian | undefined;
    protected eideDirWatcher: FileWatcher | undefined;

    // sources
    protected sourceRoots: SourceRootList;
    protected virtualSource: VirtualSource;

    private builtinEnvVars: { [key: string]: () => string } = {};

    private lock_handle: number | undefined;

    ////////////////////////////////// cpptools provider interface ///////////////////////////////////

    name: string = 'eide';
    extensionId: string = 'cl.eide';
    abstract canProvideConfiguration(uri: vscode.Uri, token?: vscode.CancellationToken | undefined): Thenable<boolean>;
    abstract provideConfigurations(uris: vscode.Uri[], token?: vscode.CancellationToken | undefined): Thenable<SourceFileConfigurationItem[]>;
    abstract canProvideBrowseConfiguration(token?: vscode.CancellationToken | undefined): Thenable<boolean>;
    abstract provideBrowseConfiguration(token?: vscode.CancellationToken | undefined): Thenable<WorkspaceBrowseConfiguration | null>;
    abstract canProvideBrowseConfigurationsPerFolder(token?: vscode.CancellationToken | undefined): Thenable<boolean>;
    abstract provideFolderBrowseConfiguration(uri: vscode.Uri, token?: vscode.CancellationToken | undefined): Thenable<WorkspaceBrowseConfiguration | null>;
    abstract dispose(): void;
    abstract forceUpdateCpptoolsConfig(): void;

    ////////////////////////////////// Base Api ///////////////////////////////////////////

    public getProjectName(): string {
        return this.GetConfiguration().config.name;
    }

    public getProjectCurrentTargetName(): string {
        return this.getCurrentTarget();
    }

    public getProjectType(): ProjectType {
        return this.GetConfiguration().config.type;
    }

    public getRootDir(): File {
        return this.GetRootDir();
    }

    public getExecutablePathWithoutSuffix(): string {
        return [this.getRootDir().path, this.getOutputDir(), this.getProjectName()].join(File.sep);
    }

    /**
     * get build output elf executable file path
     * @note not hex, bin file path
    */
    public getExecutablePath(): string {
        return this.getExecutablePathWithoutSuffix() + this.getToolchain().elfSuffix;
        // @discard parse from file
        // ------------------------------
        // let suffix = '.axf';
        // try {
        //     let fpath = `${ResManager.GetInstance().getBuilderModelsDir().path}/${this.getToolchain().modelName}`;
        //     let model = JSON.parse(fs.readFileSync(fpath).toString());
        //     if (model['groups']['linker'] &&
        //         model['groups']['linker']['$outputSuffix'] != undefined) {
        //         suffix = model['groups']['linker']['$outputSuffix'];
        //     }
        // } catch (error) {
        //     GlobalEvent.log_error(error);
        // }
        // return this.getExecutablePathWithoutSuffix() + suffix;
    }

    public getUid(): string {
        const miscInfo = this.GetConfiguration().config.miscInfo;
        if (miscInfo.uid == undefined) miscInfo.uid = md5(`${this.getEideDir().path}-${Date.now()}`);
        return miscInfo.uid;
    }

    public toolchainName(): ToolchainName {
        return this.getToolchain().name;
    }

    public toAbsolutePath(p: string): string {
        return this.ToAbsolutePath(p);
    }

    public toRelativePath(p: string): string {
        return this.ToRelativePath(p) || File.ToUnixPath(p);
    }

    public resolveEnvVar(p: string): string {
        return this.replacePathEnv(p);
    }

    public comparePath(path1: string, path2: string): boolean {
        const abs1 = this.toAbsolutePath(path1);
        const abs2 = this.toAbsolutePath(path2);
        // windows 上盘符可能不区分大小写，因此需比较相对路径
        if (platform.osType() == 'win32') {
            const repath1 = this.toRelativePath(abs1);
            const repath2 = this.toRelativePath(abs2);
            return repath1 === repath2;
        } else {
            return abs1 === abs2;
        }
    }

    public registerBuiltinVar(key: string, func: () => string) {
        this.builtinEnvVars[key] = func;
    }

    public enumBuiltinVars(): string[] {
        const keys: string[] = [];
        for (const key in this.builtinEnvVars) keys.push(key);
        return keys;
    }

    public getBuiltinVarValue(key: string): string | undefined {
        const func = this.builtinEnvVars[key];
        if (func !== undefined) {
            return func();
        }
    }

    public getBuiltinVarKvMap(): { [key: string]: string } {
        const _env: { [key: string]: string } = {};
        for (const key in this.builtinEnvVars) _env[key] = this.builtinEnvVars[key]();
        return _env;
    }

    public getProjectVariables(): { [key: string]: string } {
        const _env: { [key: string]: string } = SettingManager.GetInstance().getGlobalEnvVariables() || {};
        /* set user env */
        const _uenv = this.getProjectUserEnv();
        for (const key in _uenv) _env[key] = _uenv[key];
        /* set built-in env */
        const _ienv = this.getBuiltinVarKvMap();
        for (const key in _ienv) _env[key] = _ienv[key];
        return _env;
    }

    public getWorkspaceFile(): File {
        return this.getWsFile();
    }

    public getProjectFile(): File {
        return File.from(this.getEideDir().path, AbstractProject.prjConfigName);
    }
    public getEideProjectFile(): File {
        return this.getProjectFile();
    }

    /**
     * get project root dir, which contains *.code-workspace file
    */
    public getProjectRoot(): File {
        return this.getRootDir();
    }

    /**
     * @note Make sure you have build your project at least once time.
     * If we not found 'ref.json', an error will be throwed.
     */
    public getSourceObjectPath(srcPath: string): string | undefined {

        const refFile = File.fromArray([this.ToAbsolutePath(this.getOutputDir()), 'ref.json']);
        if (!refFile.IsFile())
            throw new Error(`No such file "${refFile.path}", please build your project at least once time.`);

        let ref = jsonc.parse(refFile.Read());
        if (platform.osType() == 'win32') { // to lower-case path for win32
            ref = copyAndMakeObjectKeysToLowerCase(ref);
            srcPath = this.toAbsolutePath(srcPath).toLowerCase();
        }

        // get obj path by source file path
        return <string>ref[srcPath];
    }

    /**
     * @note Make sure you have build your project at least once time.
     * If we not found 'compile_commands.json', an error will be throwed.
     */
    public getSourceCompileDatabase(srcPath: string): {
        directory: string,
        file: string,
        command: string
    } | undefined {

        const dbfile = File.fromArray([this.ToAbsolutePath(this.getOutputDir()), 'compile_commands.json']);
        if (!dbfile.IsFile())
            throw new Error(`No such file "${dbfile.path}", please build your project at least once time.`);

        const database: any[] = jsonc.parse(dbfile.Read());
        if (!Array.isArray(database))
            throw new Error(`Not a json array. incorrect format of compile_commands.json`);

        const absSrcPath = this.toAbsolutePath(srcPath);
        const idx = database.findIndex((item) => {
            if (platform.osType() == 'win32') {
                return (<string>item.file).toLowerCase() === absSrcPath.toLowerCase();
            } else {
                return item.file === absSrcPath;
            }
        });

        if (idx === -1)
            return;

        return database[idx];
    }

    ////////////////////////////////// Abstract Project ///////////////////////////////////

    constructor() {
        this._event = new events.EventEmitter();
        this.sourceRoots = new SourceRootList(this);
        this.virtualSource = new VirtualSource(this);
        this.configMap = new ConfigMap();
        this.packManager = new PackageManager(this);
        this.dependenceManager = new DependenceManager(this);
    }

    protected emit(event: 'dataChanged', type?: DataChangeType): boolean;
    protected emit(event: 'cppConfigChanged'): boolean;
    protected emit(event: 'targetSwitched', t: { name: string, isNew?: boolean; }): boolean;
    protected emit(event: 'projectFileChanged'): boolean;
    protected emit(event: any, argc?: any): boolean {
        return this._event.emit(event, argc);
    }

    on(event: 'dataChanged', listener: (type?: DataChangeType) => void): this;
    on(event: 'cppConfigChanged', listener: () => void): this;
    on(event: 'targetSwitched', listener: (t: { name: string, isNew?: boolean; }) => void): this;
    on(event: 'projectFileChanged', listener: () => void): this;
    on(event: any, listener: (argc?: any) => void): this {
        this._event.on(event, listener);
        return this;
    }

    static getFileFilters(): RegExp[] {
        return [this.cppfileFilter, this.headerFilter, this.libFileFilter, this.asmfileFilter];
    }

    static getSourceFileFilter(): RegExp[] {
        return [this.cppfileFilter, this.libFileFilter, this.asmfileFilter];
    }

    static getSourceFileFilterWithoutObj(): RegExp[] {
        return [this.cppfileFilter, this.asmfileFilter];
    }

    static equal(p1: AbstractProject, p2: AbstractProject) {
        return p1.getWsPath() === p2.getWsPath();
    }

    static isVirtualSourceGroup(grp: FileGroup): boolean {
        return (<ProjectFileGroup>grp).dir == undefined;
    }

    static validateProjectName(value: string): string | undefined {

        if (value.trim() === '') {
            return view_str$operation$name_can_not_be_blank;
        }

        if (/\s+/.test(value)) {
            return `can't contain whitespace in your project name !`;
        }

        if (/&|<|>|\(|\)|@|\^|\|/.test(value)) {
            return view_str$operation$name_can_not_have_invalid_char;
        }
    }

    static formatProjectName(name: string): string {
        return name
            .replace(/\s+/g, '-')
            .replace(/&|<|>|\(|\)|@|\^|\|/g, '_');
    }

    //---

    private loadProjectDirectory() {

        // init watcher for '.eide' folder
        this.eideDirWatcher = new FileWatcher(this.getEideDir(), false, false);
        this.eideDirWatcher.on('error', err => GlobalEvent.log_error(err));
        this.eideDirWatcher.OnChanged = f => this.onEideDirChanged('changed', f);
        this.eideDirWatcher.OnRename = f => this.onEideDirChanged('renamed', f);

        // compat old project
        if (this.isOldVersionProject) {

            // these folder is for old eide version
            // we will delete them
            const oldDepsFolders = [
                new File(this.getEideDir().path + File.sep + 'deps'),
                new File(this.GetRootDir().path + File.sep + 'deps'),
                new File(this.GetRootDir().path + File.sep + 'dependence')
            ];
            for (const folder of oldDepsFolders) {
                platform.DeleteDir(folder);
            }

            // merge old 'env.ini' files for v2.15.3^
            const envFile: File = this.getEnvFile(true);
            if (!envFile.IsFile()) { // if 'env.ini' file is not existed, we try to merge it
                const oldEnv: string[] = [];
                this.getEideDir().GetList([/[^\.]+\.env\.ini$/], File.EXCLUDE_ALL_FILTER)
                    .forEach((file) => {
                        const tName = NodePath.basename(file.path, '.env.ini');
                        if (tName) {
                            try {
                                const cfg = ini.parse(file.Read());
                                if (cfg['workspace']) { // merge old prj order cfg
                                    cfg['EIDE_BUILD_ORDER'] = cfg['workspace']['order'];
                                    delete cfg['workspace'];
                                }
                                const cfg_str = ini.stringify(cfg);
                                fs.unlinkSync(file.path); // delete file before
                                oldEnv.push(`[${tName}]`, `${cfg_str}`);
                            } catch (error) {
                                // nothing todo
                            }
                        }
                    });
                if (oldEnv.length > 0) {
                    const cont = this.getEnvFileDefCont().concat(oldEnv);
                    envFile.Write(cont.join(os.EOL));
                }
            }

            // add some compatiable settings for old project
            {
                const workspaceConfig = this.GetWorkspaceConfig();
                const settings = workspaceConfig.config.settings;

                // auto search includePath and libPath for old ver project
                if (this.oldProjectVersion &&
                    compareVersion('3.3', this.oldProjectVersion) > 0) { // old ver < 3.3
                    settings['EIDE.SourceTree.AutoSearchIncludePath'] = true;
                    settings['EIDE.SourceTree.AutoSearchObjFile'] = true;
                    workspaceConfig.Save(true); // save it now
                }
            }
        }
    }

    private initProjectConfig() {

        const prjConfig = this.GetConfiguration();

        // clear duplicated excl items
        prjConfig.config.excludeList = ArrayDelRepetition(
            prjConfig.config.excludeList.map(p => File.ToUnixPath(p))
        );

        // clear empty items for user prj attrs
        const prjAttr = prjConfig.CustomDep_getDependence();
        prjAttr.defineList = prjAttr.defineList.filter(m => m.trim() != '');
        prjAttr.incList = prjAttr.incList.filter(m => m.trim() != '');
        prjAttr.libList = prjAttr.libList.filter(m => m.trim() != '');

        // clear invalid src folders
        //prjConfig.config.srcDirs = prjConfig.config.srcDirs.filter(p => File.IsDir(p));

        // rm prefix for out dir
        prjConfig.config.outDir = File.normalize(File.ToLocalPath(prjConfig.config.outDir));

        // use unix path for source path
        if (this.isNewProject || this.isOldVersionProject) {
            const dStack = [prjConfig.config.virtualFolder];
            while (dStack.length > 0) {
                const vFolder = <VirtualFolder>dStack.pop();
                vFolder.files.forEach(vFile => vFile.path = File.ToUnixPath(vFile.path));
                vFolder.folders.forEach(d => dStack.push(d));
            }
        }
    }

    private initProjectComponents() {

        const prjConfig = this.GetConfiguration();

        // init components
        this.packManager.Init();
        this.dependenceManager.Init();

        // auto add deps folder to project
        if (this.isNewProject) {
            if (prjConfig.config.type === 'ARM') { // force add `dependence` folder to project and include list
                // nothing todo
            } else { // remove these folders for other mcu project
                // nothing todo
            }
        }

        // remove old deps folder
        if (this.isOldVersionProject) {
            prjConfig.RemoveSrcDir(NodePath.join(this.getRootDir().path, AbstractProject.EIDE_DIR, 'deps'));
            prjConfig.CustomDep_RemoveIncDir(this.toAbsolutePath('.eide/deps'));
        }
    }

    getWsPath(): string {
        return this.GetWorkspaceConfig().GetFile().path;
    }

    getWsFile(): File {
        return this.GetWorkspaceConfig().GetFile();
    }

    GetPackManager(): PackageManager {
        return this.packManager;
    }

    GetDepManager(): DependenceManager {
        return this.dependenceManager;
    }

    getSourceIncludeList(): string[] {
        return this.sourceRoots.getIncludeList();
    }

    getFileGroups(): FileGroup[] {
        return (<FileGroup[]>this.sourceRoots.getFileGroups()).concat(this.virtualSource.getFileGroups());
    }

    getAllSources(): { path: string, virtualPath?: string; }[] {

        const srcList: { path: string, virtualPath?: string; }[] = [];
        const fGoups = this.getFileGroups();
        const filter = AbstractProject.getSourceFileFilter();

        for (const group of fGoups) {
            if (group.disabled) continue; // skip disabled group
            for (const source of group.files) {
                if (source.disabled) continue; // skip disabled file
                if (!filter.some((reg) => reg.test(source.file.path))) continue; // skip non-source
                const rePath = this.ToRelativePath(source.file.path);
                const fInfo: any = { path: rePath || source.file.path }
                if (AbstractProject.isVirtualSourceGroup(group)) {
                    fInfo.virtualPath = `${group.name}/${source.file.name}`;
                }
                srcList.push(fInfo);
            }
        }

        return srcList;
    }

    /**
     * get project root folder
    */
    GetRootDir(): File {
        return <File>this.rootDir;
    }

    getSourceRootFolders(): FolderInfo[] {
        return this.sourceRoots.getRootFolderList();
    }

    getVirtualSourceRoot(): VirtualFolder {
        return deepCloneObject(this.virtualSource.getRoot());
    }

    getVirtualSourceManager(): VirtualSource {
        return this.virtualSource;
    }

    getNormalSourceManager(): SourceRootList {
        return this.sourceRoots;
    }

    refreshSourceRoot(rePath: string) {
        if (rePath.startsWith(VirtualSource.rootName)) {
            this.virtualSource.notifyUpdateFolder(rePath);
        } else {
            this.sourceRoots.forceUpdateFolder(rePath);
        }
    }

    /**
     * get output dir top root name. like: `build`
    */
    getOutputRoot(): string {
        return this.GetConfiguration().getOutDirRoot();
    }

    /**
     * get output dir name. like: 'build\Debug'
    */
    getOutputDir(): string {
        return this.GetConfiguration().getOutDir();
    }

    /**
     * get output dir full file system path. like: 'c:\xxx\xxx\proj\build\Debug'
    */
    getOutputFolder(): File {
        return new File(this.ToAbsolutePath(this.GetConfiguration().getOutDir()));
    }

    getEideDir(): File {
        return <File>this.eideDir;
    }

    GetConfigMap(): ConfigMap {
        return this.configMap;
    }

    replacePathEnv(path: string): string {

        for (let cnt = 0; cnt < 3; cnt++) {

            if (!File.isEnvPath(path))
                break; // not have any env var, end

            // replace built-in env
            path = this._replaceProjEnv(path);

            // replace user env
            path = this._replaceUserEnv(path, true);

            // replace global envs
            path = this._replaceGlobalEnv(path, true);
        }

        return path;
    }

    // project internal env vars
    private _replaceProjEnv(str: string): string {

        for (const key in this.builtinEnvVars) {
            const pattern = new RegExp(String.raw`\$\{${key}\}|\$\(${key}\)`, 'ig');
            const val = this.builtinEnvVars[key]();
            str = str.replace(pattern, val);
        }

        return str;
    }

    // user defined env vars
    private _replaceUserEnv(str: string, ignore_case_sensitivity: boolean = false): string {
        const prjEnv = this.getProjectUserEnv();
        if (prjEnv) {
            for (const key in prjEnv) {
                let flag = 'g';
                if (ignore_case_sensitivity) flag += 'i';
                const reg = new RegExp(String.raw`\$\(${key}\)|\$\{${key}\}`, flag);
                str = str.replace(reg, prjEnv[key]);
            }
        }
        return str;
    }

    // plug-in global env vars
    private _replaceGlobalEnv(str: string, ignore_case_sensitivity: boolean = false): string {
        const globEnv = SettingManager.GetInstance().getGlobalEnvVariables();
        if (globEnv) {
            for (const key in globEnv) {
                let flag = 'g';
                if (ignore_case_sensitivity) flag += 'i';
                const reg = new RegExp(String.raw`\$\(${key}\)|\$\{${key}\}`, flag);
                str = str.replace(reg, globEnv[key]);
            }
        }
        return str;
    }

    ToAbsolutePath(path_: string, resolveEnv: boolean = true): string {
        const path = resolveEnv ? this.replacePathEnv(path_.trim()) : path_.trim();
        if (File.isAbsolute(path)) { return File.normalize(path); }
        return File.normalize(File.ToLocalPath(this.GetRootDir().path + NodePath.sep + path));
    }

    /**
     * Convert absolute path to `Unix style` relative path.
     * 
     * Relative path root folder: `<Project_Root_Folder>`
     * 
     * @param path absolute path
     * 
     */
    ToRelativePath(path: string): string | undefined {
        return this.GetRootDir().ToRelativePath(path.trim());
    }

    async Load(wsFile: File) {

        this.lock_handle = FileLock.lock([os.tmpdir(), `${md5(wsFile.path)}.lock`].join(NodePath.sep));
        if (this.lock_handle == undefined) {
            throw new Error(view_str$prompt$project_is_opened_by_another.replace('{path}', wsFile.path));
        }

        try {
            await this.BeforeLoad(wsFile);
            this.LoadConfigurations(wsFile);
            this.loadProjectDirectory();
            this.initProjectConfig();
            this.loadToolchain();
            this.loadUploader();
            this.initProjectComponents();
            this.RegisterEvent();
            this.LoadSourceRootFolders();
            await this.AfterLoad();
        } catch (error) {
            if (this.lock_handle)
                FileLock.unlock(this.lock_handle);
            throw error;
        }
    }

    Close() {
        if (this.lock_handle)
            FileLock.unlock(this.lock_handle);
        this.sourceRoots.DisposeAll();
        this.configMap.Dispose();
        this.eideDirWatcher?.Close();
    }

    async Create(option: CreateOptions) {
        await this.Load(this.create(option));
    }

    InstallComponent(name: string) {
        const device = this.packManager.GetCurrentDevice();
        if (device) {
            const component = this.packManager.FindComponent(name);
            if (component) {
                try {
                    this.dependenceManager.InstallComponent(device.packInfo.name, component);
                } catch (error) {
                    GlobalEvent.emit('msg', ExceptionToMessage(error, 'Warning'));
                }
            }
        }
    }

    UninstallComponent(name: string) {
        const device = this.packManager.GetCurrentDevice();
        if (device) {
            const component = this.packManager.FindComponent(name);
            if (component) {
                this.dependenceManager.UninstallComponent(device.packInfo.name, component.groupName);
            }
        }
    }

    GetConfiguration<T>(): ProjectConfiguration<T> {
        return <ProjectConfiguration<T>>this.configMap.Get<ProjectConfigData<any>>(AbstractProject.prjConfigName);
    }

    GetWorkspaceConfig(): WorkspaceConfiguration {
        return <WorkspaceConfiguration>this.configMap.Get<any>(AbstractProject.workspaceSuffix);
    }

    /* GetCppConfig(): CppConfiguration {
        return <CppConfiguration>this.configMap.Get<any>(AbstractProject.cppConfigName);
    } */

    private __saveDelayTimer: NodeJS.Timeout | undefined;
    Save(immediately?: boolean, delay?: number) {
        if (immediately) {
            if (this.__saveDelayTimer) {
                clearTimeout(this.__saveDelayTimer);
                this.__saveDelayTimer = undefined;
            }
            this.configMap.SaveAll();
        } else {
            if (this.__saveDelayTimer) {
                this.__saveDelayTimer.refresh();
            } else {
                this.__saveDelayTimer = setTimeout((prj: AbstractProject) => {
                    prj.__saveDelayTimer = undefined;
                    try { prj.configMap.SaveAll(); }
                    catch (error) { GlobalEvent.emit('error', error); }
                }, delay || 800, this);
            }
        }
    }

    InstallPack(packFile: File, reporter?: (progress?: number, message?: string) => void) {
        return this.packManager.Install(packFile, reporter);
    }

    UninstallPack(packName: string) {
        return this.packManager.Uninstall(packName);
    }

    //////////////////////// project targets //////////////////////////

    getCurrentTarget(): string {
        return this.GetConfiguration().config.mode;
    }

    getTargets(): string[] {

        const prjConfig = this.GetConfiguration<any>().config;
        const result: string[] = [];

        for (const name in prjConfig.targets) {
            result.push(name);
        }

        if (prjConfig.targets[prjConfig.mode] === undefined) { // add cur target
            result.push(prjConfig.mode);
        }

        return result;
    }

    async switchTarget(targetName: string) {
        const prjConfig = this.GetConfiguration<any>().config;
        if (targetName !== prjConfig.mode) {
            const inf = this._switchTarget(targetName);
            this.reloadToolchain();
            this.reloadUploader();
            this.emit('targetSwitched', inf);
        }
    }

    deleteTarget(targetName: string) {
        if (this.getCurrentTarget() !== targetName) {
            const prjConfig = this.GetConfiguration().config;
            delete prjConfig.targets[targetName]; // delete it
        }
    }

    private saveTarget(target: string) {
        const prjConfig = this.GetConfiguration<any>();
        const prjConfigData = prjConfig.config;
        prjConfigData.targets[target] = prjConfig.cloneCurrentTarget();
    }

    private _switchTarget(targetName: string): { name: string, isNew?: boolean; } {

        const prevTargetName = this.getCurrentTarget();
        const prjConfig = this.GetConfiguration();
        const prjConfigData = prjConfig.config;
        const targets = prjConfigData.targets;

        let isNewTarget = false;

        // save old target
        this.saveTarget(prjConfigData.mode);

        // if target is not existed, create it
        if (targets[targetName] === undefined) {
            isNewTarget = true;
            targets[targetName] = prjConfig.cloneCurrentTarget();
        }

        // update current target name
        prjConfigData.mode = targetName;

        // get target
        const curTarget = <any>prjConfigData;
        const oldTarget = <any>targets[targetName];

        // update project
        this.setToolchain(targets[targetName].toolchain, true);
        this.setUploader(targets[targetName].uploader, true);

        // update project data
        for (const name in oldTarget) {

            if (name === 'custom_dep') {
                const curDep = this.GetConfiguration().CustomDep_getDependence();
                const oldDep = oldTarget[name];
                for (const key in curDep) { (<any>curDep)[key] = copyObject(oldDep[key]); }
                // convert to abs path
                curDep.incList = curDep.incList.map(path => this.ToAbsolutePath(path, false));
                curDep.libList = curDep.libList.map(path => this.ToAbsolutePath(path, false));
                continue;
            }

            if (name === 'compileConfig') {
                const compileConfig = prjConfig.compileConfigModel.data;
                const oldCompileConfig = oldTarget[name];
                // delete all properties
                for (const key in compileConfig) {
                    delete compileConfig[key];
                }
                // update properties
                for (const key in oldCompileConfig) {
                    compileConfig[key] = copyObject(oldCompileConfig[key]);
                }
                continue;
            }

            if (name === 'uploadConfig') {
                const uploadConfig = prjConfig.uploadConfigModel.data;
                const oldUploadConfig = oldTarget[name];
                // delete all properties
                for (const key in uploadConfig) {
                    delete uploadConfig[key];
                }
                // update properties
                for (const key in oldUploadConfig) {
                    uploadConfig[key] = copyObject(oldUploadConfig[key]);
                }
                continue;
            }

            if (!MAPPED_KEYS_IN_TARGET_INFO.includes(name))
                continue;

            curTarget[name] = copyObject(oldTarget[name]);
        }

        // copy source options if not exist
        const opts = this.getSourceExtraArgsCfg(prevTargetName);
        if (opts) {
            this.setSourceExtraArgsCfg(opts, targetName);
        }

        this.sourceRoots.forceUpdateAllFolders();
        this.virtualSource.forceUpdateAllFolders();

        return {
            name: targetName,
            isNew: isNewTarget,
        }
    }

    getPrevToolchain(): IToolchian | undefined {
        return this.prevToolchain;
    }

    getToolchain(): IToolchian {
        return <IToolchian>this.toolchain;
    }

    setToolchain(name: ToolchainName, notReload?: boolean) {
        const prjConfig = this.GetConfiguration();
        prjConfig.setToolchain(name);
        if (!notReload) this.reloadToolchain();
    }

    getUploaderType(): HexUploaderType {
        return this.GetConfiguration().config.uploader;
    }

    setUploader(uploader: HexUploaderType, notReload?: boolean) {
        const prjConfig = this.GetConfiguration();
        prjConfig.setHexUploader(uploader);
        if (!notReload) this.reloadUploader();
    }

    //--

    isExcluded(path: string): boolean {
        const excList = this.GetConfiguration().config.excludeList.map((excpath) => this.resolveEnvVar(excpath));
        const rePath = this.toRelativePath(path);
        return excList.findIndex(excluded => rePath === excluded || rePath.startsWith(`${excluded}/`)) !== -1;
    }

    protected addExclude(path: string): boolean {
        const excludeList = this.GetConfiguration().config.excludeList;
        const rePath = this.toRelativePath(path);
        if (!excludeList.includes(rePath)) { // not existed, add it
            excludeList.push(rePath);
            return true;
        }
        return false;
    }

    protected clearExclude(path: string): boolean {
        const excludeList = this.GetConfiguration().config.excludeList;
        const rePath = this.toRelativePath(path);
        const index = excludeList.indexOf(rePath);
        if (index !== -1) { // if existed, clear it
            excludeList.splice(index, 1);
            return true;
        }
        return false;
    }

    excludeSourceFile(path: string) {
        const srcFilter = AbstractProject.getSourceFileFilter();
        if (srcFilter.some((reg) => reg.test(path))) {
            if (this.addExclude(path)) {
                this.sourceRoots.notifyUpdateFile(path);
                this.virtualSource.notifyUpdateFile(path);
            }
        }
    }

    unexcludeSourceFile(path: string) {
        if (this.clearExclude(path)) {
            this.sourceRoots.notifyUpdateFile(path);
            this.virtualSource.notifyUpdateFile(path);
        }
    }

    //--

    excludeFolder(absPath: string) {
        if (this.addExclude(absPath)) {
            this.sourceRoots.notifyUpdateFolder(absPath);
            this.virtualSource.notifyUpdateFolder(absPath);
        }
    }

    unexcludeFolder(absPath: string) {
        if (this.clearExclude(absPath)) {
            this.sourceRoots.notifyUpdateFolder(absPath);
            this.virtualSource.notifyUpdateFolder(absPath);
        }
    }

    //--

    /**
     * @return duplicated paths list
    */
    addIncludePaths(pathList: string[]): string[] {

        const srcIncList = this.sourceRoots.getIncludeList();
        const dupList: string[] = [];
        const incList: string[] = [];

        pathList.forEach((path) => {
            if (srcIncList.includes(path)) {
                dupList.push(path);
            } else {
                incList.push(path);
            }
        });

        this.GetConfiguration()
            .CustomDep_AddIncFromPathList(incList)
            .forEach((p) => { dupList.push(p); });

        return dupList;
    }

    installCmsisSourceCodePack(pList: { name: string; zippath: string; exportIncs?: string[] } []) {

        if (pList.length == 0) {
            return;
        }

        const doneList: string[] = [];

        for (const packInfo of pList) {

            const outDir = File.fromArray([this.GetRootDir().path, '.cmsis', packInfo.name]);
            const rePath = this.ToRelativePath(outDir.path) || outDir.path;

            if (outDir.IsDir()) {
                GlobalEvent.log_warn(`'${rePath}' directory is already exists !, Aborted !`);
                continue;
            }

            outDir.CreateDir(true);
            const compresser = new SevenZipper(ResManager.GetInstance().Get7zDir());
            compresser.UnzipSync(new File(packInfo.zippath), outDir);

            // add to include folder
            if (packInfo.exportIncs) {
                const incLi = packInfo.exportIncs.map(p => {
                    let path = p.trim();
                    if (path == '.') path = '';
                    return path ? (outDir.path + File.sep + path) : outDir.path;
                });
                this.addIncludePaths(incLi);
            }

            doneList.push(rePath);
        }

        if (doneList.length > 0) {
            GlobalEvent.emit('msg', newMessage('Info', `Installation completed !, [path list]: ${doneList.join(', ')}`));
        }
    }

    installCmsisLibs() {

        const packs = ResManager.GetInstance().getCmsisLibPacks();
        if (Object.keys(packs).length == 0) {
            GlobalEvent.emit('msg', newMessage('Info', 'Not found available libraries !'));
            return;
        }

        const prjLibTypKeywords: Map<ToolchainName, string[]> = new Map();
        prjLibTypKeywords.set('AC5', ['arm', 'armcc', 'keil']);
        prjLibTypKeywords.set('AC6', ['arm', 'armcc', 'armclang', 'keil']);
        prjLibTypKeywords.set('GCC', ['gcc', 'gnu']);
        prjLibTypKeywords.set('IAR_ARM', ['iar']);

        const matchLibFileAndCpuTyp = (fname: string, cpuname: string): boolean => {

            const archNameKeywords: { [name: string]: string[] } = {
                'armv8': ['arm', 'v8'],
                'cortex-m0': ['cortex', 'm0'],
                'cortex-m3': ['cortex', 'm3'],
                'sc300': ['cortex', 'm3'],
                'sc000': ['cortex', 'm0'],
                'cortex-m33': ['cortex', 'm33'],
                'cortex-m4': ['cortex', 'm4'],
                'cortex-m7': ['cortex', 'm7'],
                'cortex-r4': ['cortex', 'r4'],
                'cortex-r5': ['cortex', 'r5'],
                'cortex-r7': ['cortex', 'r7'],
                'cortex-r8': ['cortex', 'r8']
            };

            fname = fname.toLowerCase();
            cpuname = cpuname.toLowerCase();

            for (const ckey in archNameKeywords) {
                if (cpuname.includes(ckey)) {
                    const keywords = archNameKeywords[ckey];
                    if (keywords.every(k => fname.includes(k))) {
                        return true;
                    }
                }
            }

            return false;
        };

        const doneList: string[] = [];

        for (const distname in packs) {

            const zipfile = packs[distname];
            const outDir = File.fromArray([this.GetRootDir().path, '.cmsis', distname]);
            const rePath = this.ToRelativePath(outDir.path) || outDir.path;

            // install
            outDir.CreateDir(true);
            platform.DeleteAllChildren(outDir);
            const compresser = new SevenZipper();
            compresser.UnzipSync(zipfile, outDir);

            // add include
            const incroot = File.from(outDir.path, 'include');
            if (incroot.IsDir()) {
                this.GetConfiguration().CustomDep_AddIncDir(incroot);
            }

            // add lib
            const libroot = File.from(outDir.path, 'lib');
            if (libroot.IsDir()) {
                const libPaths: string[] = [libroot.path];
                const keywords = prjLibTypKeywords.get(this.getToolchain().name);
                if (keywords) {
                    // do match
                    const subdirs = libroot
                        .GetList(File.EXCLUDE_ALL_FILTER, undefined)
                        .filter(f => keywords.some(k => f.name.toLowerCase().includes(k)));
                    // matched dirs, filter files
                    if (subdirs.length > 0) {
                        const cpuTyp = (<ArmBaseCompileConfigModel>this.GetConfiguration().compileConfigModel).data.cpuType;
                        const allfiles = subdirs[0].GetList(undefined, File.EXCLUDE_ALL_FILTER);
                        const unusedFiles = allfiles.filter(f => !matchLibFileAndCpuTyp(f.name, cpuTyp));
                        libPaths.push(subdirs[0].path);
                        if (unusedFiles.length < allfiles.length) {
                            unusedFiles.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { } });
                        }
                    }
                    // delete non-matched dirs
                    libroot.GetList(File.EXCLUDE_ALL_FILTER, undefined)
                        .filter(f => !keywords.some(k => f.name.toLowerCase().includes(k)))
                        .forEach(f => platform.DeleteDir(f));
                }

                this.GetConfiguration().CustomDep_AddAllFromLibList(libPaths);
            }

            doneList.push(rePath);
        }

        if (doneList.length > 0) {
            GlobalEvent.emit('msg', newMessage('Info', `Installation completed !, [path list]: ${doneList.join(', ')}`));
        }
    }

    //-------------------- other ------------------

    supportArmccMemeoryAssignment(): boolean {
        let isUseCustomScatterFile = false;
        if (this.getProjectType() == 'ARM')
            isUseCustomScatterFile = this.GetConfiguration<ArmBaseCompileData>().config
                .compileConfig.useCustomScatterFile;
        const toolchainName = this.getToolchain().name;
        return (toolchainName === 'AC5' || toolchainName === 'AC6') && !isUseCustomScatterFile;
    }

    getLibsGeneratorCfgFile(notCreate: boolean = false): File {

        const target = this.getCurrentTarget().toLowerCase();
        const optFile = File.fromArray([this.getEideDir().path, `${target}.libs.yml`]);

        if (!optFile.IsFile() && !notCreate) {
            const templateFile = File.fromArray([
                ResManager.GetInstance().GetAppDataDir().path, 'template.libs.yml'
            ]);
            optFile.Write(templateFile.Read());
        }

        return optFile;
    }

    /**
     * @param makefile_repath a path relative from build output dir, like: '.lib/Makefile'
    */
    genLibsMakefileContent(makefile_repath: string): string | undefined {

        const fcfg = this.getLibsGeneratorCfgFile(true);
        if (!fcfg.IsFile())
            return undefined;

        let cfg: any;
        try {
            cfg = yaml.parse(fcfg.Read());
        } catch (error) {
            GlobalEvent.emit('msg', newMessage('Warning', `Parse '${fcfg.name}' failed !`));
            GlobalEvent.log_error(error);
            GlobalEvent.emit('globalLog.show');
            return undefined;
        }

        if (cfg == undefined || Object.keys(cfg).length == 0)
            return undefined;

        // --------------------------
        // - get compiler params
        // --------------------------

        let AR_PATH: string;
        let AR_PARAMS: string;
        let AR_OBJ_SEP: string;
        let AR_OUT_SUFFIX: string;
        let CC_OBJ_SUFFIX: string;
        try {
            const compiler = this.getToolchain();
            let mname = compiler.modelName;
            let fpath = `${ResManager.GetInstance().getBuilderModelsDir().path}/${mname}`;
            let model = JSON.parse(fs.readFileSync(fpath).toString());
            // linker
            let mlink = model['groups']['linker-lib'];
            if (mlink == undefined) {
                throw new Error(`${mname}: model['groups']['linker-lib'] is undefined !`);
            }
            AR_PATH = File.ToUnixPath(compiler.getToolchainDir().path + '/' + mlink['$path']);
            if (compiler.getToolchainPrefix)
                AR_PATH = AR_PATH.replace('${toolPrefix}', compiler.getToolchainPrefix());
            if (AR_PATH.includes(' '))
                AR_PATH = `"${AR_PATH}"`;
            AR_PARAMS = mlink['$output'];
            if (AR_PARAMS == undefined) {
                throw new Error(`${mname}: model['groups']['linker-lib']['$output'] is undefined !`);
            }
            AR_OBJ_SEP = mlink['$objPathSep'] || ' ';
            AR_OUT_SUFFIX = mlink['$outputSuffix'] || '';
            // cc
            let mcc = model['groups']['c'] || model['groups']['c/cpp'];
            if (mcc == undefined) {
                throw new Error(`${mname}: model['groups']['c/cpp'] is undefined !`);
            }
            CC_OBJ_SUFFIX = mcc['$outputSuffix'] || '.o';
        } catch (error) {
            GlobalEvent.log_error(error);
            return undefined;
        }

        // --------------------------
        // - match objs
        // --------------------------

        const libs: { [name: string]: string[] } = {};
        const allobjs: string[] = [];
        const objroot = '.obj';
        const objsuffix = CC_OBJ_SUFFIX;

        this.getAllSources().forEach((src) => {
            let path = File.ToUnixPath(src.path);
            let nam = NodePath.basename(path, NodePath.extname(path));
            let dir = NodePath.dirname(path);
            path = dir + '/' + nam + objsuffix;
            allobjs.push(path);
        });

        for (const name in cfg) {

            if (name.startsWith('$'))
                continue; // skip internal vars

            let exprs: string[] = cfg[name];
            if (!Array.isArray(exprs)) continue;

            let libobjs: string[] = [];
            for (const expr of exprs) {
                allobjs.forEach(p => {
                    const searchPath = this.toRelativePath(p)
                        .replace(/\.\.\//g, '')
                        .replace(/\.\//g, ''); // globmatch bug ? it can't parse path which have '.' or '..'
                    if (globmatch.isMatch(searchPath, expr)) {
                        libobjs.push(p);
                    }
                });
            }
            libobjs = ArrayDelRepetition(libobjs);
            if (libobjs.length > 0) {
                libs[name] = libobjs.map(path => {
                    if (File.isAbsolute(path))
                        return path;
                    else
                        return objroot + '/' + path.replace(/\.\.\//g, '__/');
                });
            }
        }

        if (cfg['$AR_PATH'])
            AR_PATH   = File.ToUnixPath(this.toAbsolutePath(cfg['$AR_PATH']));
        if (cfg['$AR_CMD'])
            AR_PARAMS = cfg['$AR_CMD'];

        // --------------------------
        // - gen makefile
        // --------------------------

        let lib_rules: string[] = [];

        for (const libname in libs) {
            let objs = libs[libname];
            let outname = `$(OUT_DIR)/${libname + AR_OUT_SUFFIX}`;
            let AR_CMD = AR_PARAMS
                .replace('${in}', () => `$(lib${libname}_OBJS)`)
                .replace('${out}', outname);
            let rule_tmp = `# ${libname}
lib${libname}_OBJS += ${objs.join(AR_OBJ_SEP)}
lib${libname}: $(lib${libname}_OBJS) ${makefile_repath}
\t@echo -e $(COLOR_BLUE)-------------------------$(COLOR_END)
\t@echo -e $(COLOR_BLUE)AR "${outname}"$(COLOR_END)
\t@echo -e $(COLOR_BLUE)-------------------------$(COLOR_END)
\t$(AR) ${AR_CMD}
OUT_LIBS += lib${libname}
`;
            lib_rules.push(rule_tmp);
        }

        let mk_tmp = `
# --------------------------------------------
#  !!! DON'T EDIT THESE, IT'S AUTO CREATED !!!
# --------------------------------------------

OUT_DIR = <LIB_OUT_DIR>
AR = <LIB_AR_PATH>

# colors
COLOR_END  = "\\e[0m"
COLOR_WARN = "\\e[33;1m"
COLOR_DONE = "\\e[32;1m"
COLOR_ERR  = "\\e[31;1m"
COLOR_BLUE = "\\e[34;1m"

# --------------------------------------------
#  libs targets
# --------------------------------------------

<LIB_TARGETS>

# --------------------------------------------
#  all target
# --------------------------------------------

all: $(OUT_DIR) $(OUT_LIBS)
\t@echo -e $(COLOR_DONE)"-------------------------"$(COLOR_END)
\t@echo -e $(COLOR_DONE)"all done"$(COLOR_END)
\t@echo -e $(COLOR_DONE)"-------------------------"$(COLOR_END)

$(OUT_DIR):
\tmkdir -p $@
`;

        mk_tmp = mk_tmp
            .replace('<LIB_TARGETS>', lib_rules.join('\n'))
            .replace('<LIB_OUT_DIR>', NodePath.dirname(makefile_repath))
            .replace('<LIB_AR_PATH>', AR_PATH);

        return mk_tmp;
    }

    isAutoSearchObjectFile(): boolean {
        return this.sourceRoots.isAutoSearchObjectFile();
    }

    readIgnoreList(): string[] {
        const ignoreFile = new File(this.ToAbsolutePath(`.${File.sep}.eideignore`));
        if (ignoreFile.IsFile()) {
            return ignoreFile.Read()
                .split(/\r\n|\n/)
                .map((line) => { return line.trim(); })
                .filter((line) => {
                    return line !== '' && !line.startsWith('#') && /^[^\s]+$/.test(line);
                });
        }
        return [];
    }

    private getEnvFileDefCont(): string[] {
        return [
            `###########################################################`,
            `#              project environment variables`,
            `###########################################################`,
            ``,
            `# append command prefix for toolchain`,
            `#COMPILER_CMD_PREFIX=`,
            ``,
            `# mcu ram size (used to print memory usage)`,
            `#MCU_RAM_SIZE=0x00`,
            ``,
            `# mcu rom size (used to print memory usage)`,
            `#MCU_ROM_SIZE=0x00`,
            ``,
            `# put your global variables ...`,
            `#GLOBAL_VAR=`,
            ``,
        ].map((line) => line);
    }

    getEnvFile(notInitFile?: boolean): File {

        const envFile = new File(`${this.getEideDir().path}${File.sep}env.ini`);
        if (!notInitFile && !envFile.IsFile()) {
            const defTxt: string[] = this.getEnvFileDefCont();
            defTxt.push(
                `[debug]`,
                `# put your variables for 'debug' target ...`,
                `#VAR=`
            )
            envFile.Write(defTxt.join(os.EOL));
        }

        return envFile;
    }

    private __env_raw_lastGetTime: number = 0;
    private __env_raw_lastUpdateTime: number = 0;
    private __env_raw_lastEnvObj: { [name: string]: any } | undefined;
    getProjectRawEnv(): { [name: string]: any } | undefined {
        try {
            // limit read interval (350 ms), improve speed
            if (this.__env_raw_lastEnvObj != undefined &&
                Date.now() - this.__env_raw_lastGetTime < 350) {
                return this.__env_raw_lastEnvObj;
            }

            // is env need update ?
            const envFile = this.getEnvFile(true);
            if (envFile.IsFile()) {
                const lastMdTime = fs.statSync(envFile.path).mtimeMs;
                if (this.__env_raw_lastEnvObj == undefined ||
                    lastMdTime > this.__env_raw_lastUpdateTime) {
                    // update env
                    this.__env_raw_lastEnvObj = ini.parse(envFile.Read());
                    this.__env_raw_lastUpdateTime = lastMdTime;
                }

                // return env objects
                this.__env_raw_lastGetTime = Date.now();
                return this.__env_raw_lastEnvObj;
            }
        } catch (error) {
            // nothing todo
        }
    }

    private __env_lastUpdateTime: number = 0;
    private __env_lastEnvObj: { [name: string]: any } | undefined;
    getProjectUserEnv(): { [name: string]: any } | undefined {

        // limit read interval (350 ms), improve speed
        if (this.__env_lastEnvObj != undefined &&
            Date.now() - this.__env_lastUpdateTime < 350) {
            return this.__env_lastEnvObj;
        }

        let env: { [name: string]: any } | undefined;

        const rawEnv = this.getProjectRawEnv();
        if (rawEnv != undefined) {
            env = JSON.parse(JSON.stringify(rawEnv));

            // override target env var
            const targetName = this.getCurrentTarget();
            for (const key in env) {
                if (typeof env[key] == 'object' && !Array.isArray(env[key]) &&
                    key.toLowerCase() === targetName.toLowerCase()) {
                    const targetEnv = env[key];
                    for (const k in targetEnv)
                        env[k] = targetEnv[k];
                }
            }

            // delete non-string obj
            for (const key in env) {
                if (typeof env[key] == 'object' ||
                    Array.isArray(env[key]) ||
                    !/^\w+$/.test(key)) {
                    delete env[key];
                }
            }
        }

        // update and ret
        this.__env_lastEnvObj = env;
        this.__env_lastUpdateTime = Date.now();
        return this.__env_lastEnvObj;
    }

    getSourceExtraArgsCfgFile(notCreate: boolean = false): File {

        const optFile = File.fromArray([this.getEideDir().path, `files.options.yml`]);
        if (!optFile.IsFile() && !notCreate) {
            const optsObj = <SourceFileOptions>{ version: EIDE_FILE_OPTION_VERSION, options: {} };
            optsObj.version = EIDE_FILE_OPTION_VERSION;
            optsObj.options[this.getCurrentTarget()] = { files: {}, virtualPathFiles: {} };
            optFile.Write(view_str$prompt$filesOptionsComment + yaml.stringify(optsObj, { indent: 4 }));
        }

        return optFile;
    }

    getSourceExtraArgsCfg(targetName?: string): SourceExtraCompilerOptionsCfg | undefined {
        try {
            const optFile = this.getSourceExtraArgsCfgFile();
            const optsObj = <SourceFileOptions>yaml.parse(optFile.Read());
            if (targetName == undefined)
                targetName = this.getCurrentTarget();
            if (optsObj.options == undefined) optsObj.options = {};
            if (optsObj.options[targetName] == undefined) optsObj.options[targetName] = {};
            return optsObj.options[targetName];
        } catch (error) {
            GlobalEvent.log_error(error);
        }
    }

    setSourceExtraArgsCfg(cfg: SourceExtraCompilerOptionsCfg, targetName?: string) {
        try {
            const optFile = this.getSourceExtraArgsCfgFile();
            const optsObj = <SourceFileOptions>yaml.parse(optFile.Read());
            optsObj.version = EIDE_FILE_OPTION_VERSION;
            optsObj.options[targetName || this.getCurrentTarget()] = cfg;
            optFile.Write(view_str$prompt$filesOptionsComment + yaml.stringify(optsObj, { indent: 4 }));
        } catch (error) {
            GlobalEvent.log_error(error);
        }
    }

    hasExtraArgsForFolder(path: string, cfg?: SourceExtraCompilerOptionsCfg, isVirtualPath?: boolean): boolean {

        let found: boolean = false;

        this._matchExtraArgsForFolder(path, isVirtualPath, cfg, () => {
            found = true;
            return true;
        });

        return found;
    }

    hasExtraArgsForFile(fspath: string, virtpath?: string, cfg?: SourceExtraCompilerOptionsCfg): boolean {

        if (cfg == undefined)
            return false;

        // for fs path
        if (cfg.files) {
            const patterns = cfg.files;
            for (const expr in patterns) {
                const searchPath = this.toRelativePath(fspath)
                    .replace(/\.\.\//g, '')
                    .replace(/\.\//g, ''); // globmatch bug ? it can't parse path which have '.' or '..'
                if (globmatch.isMatch(searchPath, expr)) {
                    return true;
                }
            }
        }

        if (cfg.virtualPathFiles && virtpath) {
            const patterns = cfg.virtualPathFiles;
            for (const expr in patterns) {
                const searchPath = virtpath.trim();
                if (globmatch.isMatch(searchPath, expr)) {
                    return true;
                }
            }
        }

        if (cfg.alwaysBuildSourceFiles) {
            const idx = cfg.alwaysBuildSourceFiles.findIndex(p => this.comparePath(p, fspath));
            if (idx !== -1) {
                return true;
            }
        }

        if (cfg.memoryAssign && this.supportArmccMemeoryAssignment()) {
            for (const filePath in cfg.memoryAssign) {
                if (virtpath && this.comparePath(filePath, <string>virtpath)) {
                    return true;
                } else if (this.comparePath(filePath, <string>fspath)) {
                    return true;
                }
            }
        }

        return false;
    }

    getExtraArgsForSource(fspath: string, virtpath?: string, cfg?: SourceExtraCompilerOptionsCfg): { [expr: string]: string | undefined } {

        if (cfg == undefined)
            return {};

        const extraArgs: { [expr: string]: string } = {};

        // for fs path
        if (cfg.files) {
            const patterns = cfg.files;
            for (const expr in patterns) {
                const searchPath = this.toRelativePath(fspath)
                    .replace(/\.\.\//g, '')
                    .replace(/\.\//g, ''); // globmatch bug ? it can't parse path which have '.' or '..'
                if (globmatch.isMatch(searchPath, expr)) {
                    const val = patterns[expr]?.replace(/\r\n|\n/g, ' ').replace(/\\r|\\n|\\t/g, ' ').trim();
                    if (val) {
                        if (extraArgs[expr]) {
                            extraArgs[expr] = extraArgs[expr] + ' ' + val;
                        } else {
                            extraArgs[expr] = val;
                        }
                    }
                }
            }
        }

        if (cfg.virtualPathFiles && virtpath) {
            const patterns = cfg.virtualPathFiles;
            for (const expr in patterns) {
                const searchPath = virtpath.trim();
                if (globmatch.isMatch(searchPath, expr)) {
                    const val = patterns[expr]?.replace(/\r\n|\n/g, ' ').replace(/\\r|\\n|\\t/g, ' ').trim();
                    if (val) {
                        if (extraArgs[expr]) {
                            extraArgs[expr] = extraArgs[expr] + ' ' + val;
                        } else {
                            extraArgs[expr] = val;
                        }
                    }
                }
            }
        }

        return extraArgs;
    }

    getExtraArgsForFolder(folderpath: string, isVirtpath?: boolean, cfg?: SourceExtraCompilerOptionsCfg): { [expr: string]: string | undefined } {

        if (cfg == undefined)
            return {};

        const extraArgs: { [expr: string]: string | undefined } = {};

        this._matchExtraArgsForFolder(folderpath, isVirtpath, cfg, (expr, path, val) => {

            if (val) {
                if (extraArgs[expr]) {
                    extraArgs[expr] = extraArgs[expr] + ' ' + val;
                } else {
                    extraArgs[expr] = val;
                }
            }

            return false;
        });

        return extraArgs;
    }

    private _matchExtraArgsForFolder(
        folderpath: string, isVirtpath?: boolean,
        cfg?: SourceExtraCompilerOptionsCfg, callbk?: (pattern: string, pathInSearch: string, out_args: string) => boolean) {

        if (cfg == undefined)
            return;

        if (isVirtpath) {
            if (cfg.virtualPathFiles) {
                const patterns = cfg.virtualPathFiles;
                for (const expr in patterns) {
                    const searchPath = folderpath.trim();
                    if (globmatch.isMatch(searchPath, expr) || searchPath == expr.replace(/\/\*\*$/, '').replace(/\/\*$/, '')) {
                        const val = patterns[expr]?.replace(/\r\n|\n/g, ' ').replace(/\\r|\\n|\\t/g, ' ').trim();
                        if (callbk) {
                            if (callbk(expr, searchPath, val))
                                return;
                        }
                    }
                }
            }
        } else { // for fs path
            if (cfg.files) {
                const patterns = cfg.files;
                for (const expr in patterns) {
                    const searchPath = this.toRelativePath(folderpath)
                        .replace(/\.\.\//g, '')
                        .replace(/\.\//g, ''); // globmatch bug ? it can't parse path which have '.' or '..'
                    if (globmatch.isMatch(searchPath, expr) || searchPath == expr.replace(/\/\*\*$/, '').replace(/\/\*$/, '')) {
                        const val = patterns[expr]?.replace(/\r\n|\n/g, ' ').replace(/\\r|\\n|\\t/g, ' ').trim();
                        if (callbk) {
                            if (callbk(expr, searchPath, val))
                                return;
                        }
                    }
                }
            }
        }
    }

    // 获取与文件路径绝对匹配的 pattern
    //  绝对匹配?: 不会匹配到其他路径或文件
    getExtraArgsAbsPatternForSource(fspath: string, virtpath?: string, cfg?: SourceExtraCompilerOptionsCfg): string | undefined {

        if (cfg == undefined)
            return undefined;

        // 优先匹配虚拟文件
        if (cfg.virtualPathFiles && virtpath) {
            const patterns = cfg.virtualPathFiles;
            const mpath = virtpath.trim();
            for (const expr in patterns) {
                if (mpath == expr)
                    return expr;
            }
        }

        // for fs path
        if (cfg.files) {
            const patterns = cfg.files;
            const mpath = this.toRelativePath(fspath)
                .replace(/\.\.\//g, '')
                .replace(/\.\//g, '');
            for (const expr in patterns) {
                if (mpath == expr)
                    return expr;
            }
        }

        return undefined;
    }

    getExtraArgsAbsPatternForFolder(folderpath: string, isVirtpath?: boolean, cfg?: SourceExtraCompilerOptionsCfg): string | undefined {

        if (cfg == undefined)
            return undefined;

        // for virtual path
        if (isVirtpath) {
            if (cfg.virtualPathFiles) {
                const patterns = cfg.virtualPathFiles;
                const mpath = folderpath.trim().replace(/\/\*\*$/, '').replace(/\/\*$/, '');
                for (const expr in patterns) {
                    if (mpath == expr.replace(/\/\*\*$/, '').replace(/\/\*$/, ''))
                        return expr;
                }
            }
        }

        // for fs path
        else if (cfg.files) {
            const patterns = cfg.files;
            const mpath = this.toRelativePath(folderpath)
                .replace(/\.\.\//g, '')
                .replace(/\.\//g, '')
                .replace(/\/\*\*$/, '').replace(/\/\*$/, '');
            for (const expr in patterns) {
                if (mpath == expr.replace(/\/\*\*$/, '').replace(/\/\*$/, ''))
                    return expr;
            }
        }

        return undefined;
    }

    getBuilderOptions(): BuilderOptions {
        return this.GetConfiguration().compileConfigModel.getOptions();
    }

    //---

    protected loadToolchain() {

        const prjConfig = this.GetConfiguration();
        const toolManager = ToolchainManager.getInstance();

        this.toolchain = toolManager.getToolchain(prjConfig.config.type, prjConfig.config.toolchain);
        let toolchainRoot = this.toolchain.getToolchainDir().path;
        this.registerBuiltinVar('ToolchainRoot', () => toolchainRoot);

        const curOptions = prjConfig.compileConfigModel.getOptions();
        const newOptions = toolManager.upgradeBuilderOptions(curOptions, this.toolchain);
        if (newOptions) {
            prjConfig.compileConfigModel.setOptions(newOptions, undefined, this.toolchain.name);
        }
    }

    protected reloadToolchain() {
        this.loadToolchain();
        this.dependenceManager.flushToolchainDep();
        this.packManager.refreshComponents();
        this.onToolchainChanged();
        this.emit('dataChanged'); // must send global event to refresh view
    }

    protected reloadUploader() {
        const prjConfig = this.GetConfiguration();
        prjConfig.uploadConfigModel.emit('NotifyUpdate', prjConfig); // notify update upload config
        this.onUploaderChanged();
        this.emit('dataChanged'); // must send global event to refresh view
    }

    protected loadUploader() {
        const prjConfig = this.GetConfiguration();
        prjConfig.uploadConfigModel.emit('NotifyUpdate', prjConfig); // notify update upload config
        this.onUploaderChanged();
    }

    protected LoadSourceRootFolders() {
        this.sourceRoots.load(true);
        this.virtualSource.load(true);
        this.onSourceRootChanged('dataChanged');
    }

    // public updateDebugConfig() {
    //     const debugConfigGenerator = IDebugConfigGenerator.newInstance(this);
    //     if (debugConfigGenerator) {
    //         const launchConfig = File.fromArray([this.GetWorkspaceConfig().GetFile().dir, AbstractProject.vsCodeDir, 'launch.json']);
    //         debugConfigGenerator.load(launchConfig);
    //         debugConfigGenerator.update();
    //     }
    // }

    protected ThrowIf(checkRes: CheckResult) {
        if (!checkRes.success) {
            if (checkRes.err) {
                throw checkRes.err;
            }
        }
    }

    protected LoadConfigurations(wsFile: File) {

        ////////////////////////////////////
        // load eide.json, init project

        // init folders
        this.rootDir = new File(wsFile.dir);
        this.eideDir = new File(this.rootDir.path + File.sep + AbstractProject.EIDE_DIR);

        // init cfgs
        this.configMap.Set(new WorkspaceConfiguration(wsFile).load(), AbstractProject.workspaceSuffix);
        const eideJsonFile = File.fromArray([wsFile.dir, AbstractProject.EIDE_DIR, AbstractProject.prjConfigName]);
        this.configMap.Set(new ProjectConfiguration(eideJsonFile).load());

        // create '.vscode' folder if it's not existed
        File.fromArray([wsFile.dir, AbstractProject.vsCodeDir]).CreateDir(true);

        /////////////////////////////////////
        // init base builtin env

        // vscode vars
        this.registerBuiltinVar('workspaceFolder', () => this.getRootDir().path);
        this.registerBuiltinVar('workspaceFolderBasename', () => this.getRootDir().name);

        // project vars
        this.registerBuiltinVar('OutDir', () => this.getRootDir().path + File.sep + this.GetConfiguration().getOutDir());
        this.registerBuiltinVar('OutDirRoot', () => this.GetConfiguration().getOutDirRoot());
        this.registerBuiltinVar('OutDirBase', () => this.GetConfiguration().getOutDir());
        this.registerBuiltinVar('ProjectName', () => this.GetConfiguration().config.name);
        this.registerBuiltinVar('ConfigName', () => this.GetConfiguration().config.mode);
        this.registerBuiltinVar('ProjectRoot', () => this.getRootDir().path);
        this.registerBuiltinVar('ExecutableName', () => this.getExecutablePathWithoutSuffix());
        this.registerBuiltinVar('ChipPackDir', () => this.GetConfiguration().config.packDir || '');
        this.registerBuiltinVar('ChipName', () => this.GetConfiguration().config.deviceName || '');

        // system vars
        this.registerBuiltinVar('SYS_Platform', () => platform.osType());
        this.registerBuiltinVar('SYS_DirSep', () => File.sep);
        this.registerBuiltinVar('SYS_DirSeparator', () => File.sep);
        this.registerBuiltinVar('SYS_PathSep', () => platform.osType() != 'win32' ? ':' : ';');
        this.registerBuiltinVar('SYS_PathSeparator', () => platform.osType() != 'win32' ? ':' : ';');
        this.registerBuiltinVar('SYS_EOL', () => os.EOL);

        // eide vars
        this.registerBuiltinVar('EIDE_BUILDER_DIR', () => ResManager.instance().getUnifyBuilderExe().dir);
        for (const key in process.env) {
            if (key.startsWith('EIDE_') && !key.startsWith('EIDE_TOOL_')) {
                this.registerBuiltinVar(key, () => process.env[key] || '');
            }
        }
    }

    private RegisterEvent(): void {

        this.sourceRoots.on('dataChanged', (e) => this.onSourceRootChanged(e));

        this.virtualSource.on('dataChanged', (e) => this.onSourceRootChanged(e));

        const prjConfig = this.GetConfiguration();

        prjConfig.on('dataChanged', (type) => this.onPrjConfigChanged(type));

        prjConfig.compileConfigModel.on('event', (eDat) => this.onConfigurationEvent(eDat));

        prjConfig.uploadConfigModel.on('event', (eDat) => this.onConfigurationEvent(eDat));

        this.packManager.on('deviceChanged', (dev) => this.onDeviceChanged(dev));

        this.packManager.on('packageChanged', () => this.onPackageChanged());

        this.packManager.on('componentUpdate', (upList) => this.onComponentUpdate(upList));

        ToolchainManager.getInstance().on('onChanged', (tName) => this.onToolchainModified(tName));

        this.on('targetSwitched', (t) => this.onTargetChanged(t));

        // update config which depend other configs
        this.on('dataChanged', (type) => {

            if (['uploader', 'pack'].includes(<string>type)) {

                // update pyOCD options
                if (type === 'pack' && prjConfig.config.uploader === 'pyOCD') {
                    const deviceInfo = this.GetPackManager().getCurrentDevInfo();
                    if (deviceInfo) {
                        prjConfig.uploadConfigModel.SetKeyValue('targetName', deviceInfo.name.toLowerCase());
                        return; // exit, because this event will trigger 'update debug config' operations
                    }
                }
            }
        });
    }

    //---

    protected isNewProject?: boolean | undefined;
    protected isOldVersionProject?: boolean | undefined;
    protected oldProjectVersion?: string | undefined;

    protected async BeforeLoad(wsFile: File): Promise<void> {

        // check project version
        const eideFile = File.fromArray([wsFile.dir, AbstractProject.EIDE_DIR, AbstractProject.prjConfigName]);
        const conf = <ProjectConfigData<any>>JSON.parse(eideFile.Read());
        if (conf.version) {
            const prj_version = conf.version;
            const eide_conf_v = EIDE_CONF_VERSION;
            const prjv_vs_eidev = compareVersion(prj_version, eide_conf_v);
            if (prjv_vs_eidev > 0) { // prj version > eide, error
                throw Error(`The project config version is '${conf.version}', but eide is '${EIDE_CONF_VERSION}'. Please update 'eide' to the latest version !`);
            } else if (prjv_vs_eidev < 0) { // prj version < eide
                this.isOldVersionProject = true;
                this.oldProjectVersion = prj_version;
            }
        }

        // check is an new project ?
        if (conf.miscInfo == undefined ||
            conf.miscInfo.uid == undefined) {
            this.isNewProject = true;
        }

        // compatibility note
        if (this.isOldVersionProject) {
            /* check this project have a package dependence ? */
            const dep_idx = conf.dependenceList.findIndex(dep =>
                dep.groupName != ProjectConfiguration.BUILD_IN_GROUP_NAME &&
                dep.groupName != ProjectConfiguration.CUSTOM_GROUP_NAME);
            if (conf.packDir && dep_idx != -1) {
                const sel = await vscode.window.showWarningMessage(
                    `${WARNING}: ${view_str$prompt$chipPkgNotCompateThisVersion}`, continue_text, cancel_text);
                if (sel !== continue_text) {
                    throw Error(view_str$prompt$userCanceledOperation);
                }
            }
        }

        // move old builder config files into eide.json
        if (this.isOldVersionProject) {
            const eideDir = File.from(eideFile.dir);
            const toolchainManager = ToolchainManager.getInstance();

            const toolchainInfos: any[] = [];
            for (const n of toolchainManager.getToolchainNameList(conf.type)) {
                const toolchain = toolchainManager.getToolchainByName(n);
                if (toolchain) {
                    toolchainInfos.push({
                        name: n,
                        configFileName: toolchain.configName
                    });
                }
            }

            // get all builder options
            const allOptions: { target_l: string, toolchain: string, options: BuilderOptions }[] = [];
            for (const file of eideDir.GetList(undefined, File.EXCLUDE_ALL_FILTER)) {
                const tidx = toolchainInfos.findIndex(info => file.name.endsWith(info.configFileName));
                if (tidx != -1) {
                    const toolInfo = toolchainInfos[tidx];
                    // get lower case target name
                    let targetName_l: string = file.name.replace(toolInfo.configFileName, '');
                    if (targetName_l == '') targetName_l = 'release';
                    else targetName_l = targetName_l.substr(0, targetName_l.length - 1);
                    // append in list
                    const options = jsonc.parse(file.Read());
                    allOptions.push({
                        target_l: targetName_l,
                        toolchain: toolInfo.name,
                        options: options,
                    });
                    // delete old builder options file, we don't need it anymore.
                    try { fs.unlinkSync(file.path); } catch {};
                }
            }

            // copy all builder options into eide.json
            const allTargetNames = Object.keys(conf.targets);
            for (const optionsInfo of allOptions) {
                const idx = allTargetNames.findIndex(
                    name => optionsInfo.target_l == name.toLowerCase());
                if (idx != -1) {
                    const targetName = allTargetNames[idx];
                    const target = conf.targets[targetName];
                    if (target.builderOptions == undefined) target.builderOptions = {};
                    target.builderOptions[optionsInfo.toolchain] = optionsInfo.options;
                }
            }
        }

        // remove 'sourceDirList' of custom_dep
        if (this.isOldVersionProject) {
            for (const name in conf.targets) {
                const target = conf.targets[name];
                if (target.custom_dep) {
                    if ((<any>target.custom_dep)['sourceDirList'] != undefined) {
                        (<any>target.custom_dep)['sourceDirList'] = undefined;
                    }
                }
            }
        }

        // merge *.files.options.yml
        const optionsFile = File.from(eideFile.dir, 'files.options.yml');
        if (!optionsFile.IsFile()) {
            const eideDir = File.from(eideFile.dir);
            const allFileOptions: { targetName: string, fileOptions: any }[] = [];
            // get all options
            for (const file of eideDir.GetList([/\.files\.options\.yml$/i], File.EXCLUDE_ALL_FILTER)) {
                const target_l = file.name.replace('.files.options.yml', '');
                if (target_l) {
                    const allTargets = Object.keys(conf.targets);
                    if (conf.mode)
                        allTargets.push(conf.mode);
                    const idx = allTargets.findIndex(t => t.toLowerCase() == target_l);
                    if (idx != -1) {
                        const fileOptions = yaml.parse(file.Read());
                        allFileOptions.push({ targetName: allTargets[idx], fileOptions: fileOptions });
                    } else {
                        GlobalEvent.log_warn(`This options file ".eide/${file.name}" not match any target. remove it !`);
                    }
                    try { fs.unlinkSync(file.path) } catch {} // delete file
                }
            }
            // merge all files options
            if (allFileOptions.length > 0) {
                const optionsObj: SourceFileOptions = { 'version': EIDE_FILE_OPTION_VERSION, options: {} };
                allFileOptions.forEach(opts => {
                    const obj = opts.fileOptions;
                    obj.version = undefined;
                    Object.keys(obj).forEach(k => {
                        if (obj[k] === undefined || obj[k] === null)
                            delete obj[k];
                    });
                    if (Object.keys(obj).length > 0)
                        optionsObj.options[opts.targetName] = obj;
                });
                // write to file
                optionsFile.Write(view_str$prompt$filesOptionsComment + yaml.stringify(optionsObj, { indent: 4 }));
            }
        }

        /* udpate project version to lastest */
        if (this.isOldVersionProject) {
            conf.version = EIDE_CONF_VERSION;
            eideFile.Write(JSON.stringify(conf, undefined, 2));
        }
    }

    protected async AfterLoad(): Promise<void> {

        const prjConfig = this.GetConfiguration();

        // start watch '.eide' folder
        try {
            this.eideDirWatcher?.Watch();
        } catch (error) {
            GlobalEvent.log_error(<Error>error);
            GlobalEvent.emit('msg', newMessage('Error', `Cannot watch '.eide' folder, some functions will not available !`));
        }

        // force flush toolchain dependence
        this.dependenceManager.Refresh(true);
        this.emit('dataChanged', 'dependence');

        // update uid if project not have
        this.getUid();

        // remove build-in deps for old version
        prjConfig.BuildIn_RemoveAllDefines();

        /* check toolchain is installed ? */
        this.checkAndNotifyInstallToolchain();
    }

    //------------------------ event callback--------------------------

    protected onConfigurationEvent(eventData: EventData): void {

        switch (eventData.event) {
            case 'openCompileOptions':
                try {
                    WebPanelManager.instance().showBuilderOptions(this);
                } catch (err) {
                    GlobalEvent.emit('error', err);
                }
                break;
            case 'openMemLayout':
                WebPanelManager.instance().showStorageLayoutView(this);
                break;
            case 'openUploadOptions':
                if (eventData.data['path'] !== undefined) {
                    const configFile = new File(this.ToAbsolutePath(eventData.data['path']));
                    if (!configFile.IsFile()) {
                        configFile.Write(eventData.data['default'] || '');
                    }
                    vscode.window.showTextDocument(vscode.Uri.parse(configFile.ToUri()), {
                        preview: true
                    });
                }
                break;
            default:
                GlobalEvent.emit('msg', newMessage('Warning', 'Invalid event \'' + eventData.event + '\''));
                break;
        }
    }

    protected onToolchainModified(tName: ToolchainName) {
        if (tName === this.getToolchain().name) { // reload toolchain
            this.loadToolchain();
            this.dependenceManager.flushToolchainDep();
            this.emit('dataChanged', 'compiler');
        }
    }

    public getToolchainLocation(): File {
        const toolchain = this.getToolchain();
        if (isGccFamilyToolchain(toolchain.name) && toolchain.getToolchainPrefix) {
            try {
                if (vscode.workspace.workspaceFile) {
                    const dir = File.from(this.getWorkspaceFile().dir);
                    const r = xpackRequireDevTools(dir, `${toolchain.getToolchainPrefix()}gcc`);
                    if (r) {
                        return r;
                    }
                }
            } catch (error) {
                GlobalEvent.log_warn(<Error>error);
                return File.from(`<xpack-dev-tools ${toolchain.getToolchainPrefix()}gcc not-exist>`);
            }
        }
        return toolchain.getToolchainDir();
    }

    public checkAndNotifyInstallToolchain(): boolean {
        const toolchain = this.getToolchain();
        if (isGccFamilyToolchain(toolchain.name) && toolchain.getToolchainPrefix) {
            try {
                if (vscode.workspace.workspaceFile) {
                    const dir = File.from(this.getWorkspaceFile().dir);
                    const r = xpackRequireDevTools(dir, `${toolchain.getToolchainPrefix()}gcc`);
                    if (r) {
                        return true;
                    }
                }
            } catch (error) {
                GlobalEvent.log_warn(<Error>error);
                const msg = [
                    `${toolchain.getToolchainPrefix()}gcc not avaliable:\n${(<Error>error).message}`,
                    `Please check your package.json and run 'xpm install' to install xpack dependences.`
                ].join(os.EOL);
                vscode.window.showErrorMessage(msg, 'Install', 'Later')
                    .then((value) => {
                        if (value == 'Install') {
                            runShellCommand('xpm install', 'xpm install', {
                                useTerminal: true,
                                cwd: this.getRootDir().path
                            });
                        }
                    });
                return false
            }
        }
        const toolchainManager = ToolchainManager.getInstance();
        if (!toolchainManager.isToolchainPathReady(toolchain.name)) {
            const dir = toolchainManager.getToolchainExecutableFolder(toolchain.name);
            const msg = view_str$prompt$not_found_compiler.replace('{}', toolchain.name) + `, [path]: '${dir?.path}'`;
            ResInstaller.instance().setOrInstallTools(toolchain.name, msg, toolchain.settingName);
            return false;
        }
        return true;
    }

    public notifySourceExplorerViewRefresh() {
        this.emit('dataChanged', 'files');
    }

    doUpdateCompilerDatabase() {

        const cmdLine = CodeBuilder.NewBuilder(this).genBuildCommand({ otherArgs: ['--only-dump-compilerdb'] });
        if (!cmdLine)
            return;

        return new Promise<boolean>((resolve) => {
            /* Output Example:
                Source Map Database Path: c:\xxx\ref.json
                Compiler Database Path: c:\xxx\compile_commands.json
            */
            const proc = new ExeCmd();
            proc.on('launch', () => {
                GlobalEvent.log_info('Updating Compiler Database');
            });
            proc.on('line', str => {
                GlobalEvent.log_info(str);
            });
            proc.on('close', exitInfo => {
                if (exitInfo.code == 0) {
                    resolve(true);
                } else {
                    resolve(false);
                    GlobalEvent.log_warn(`Fail to exec "${cmdLine}", code=${exitInfo.code}`);
                }
            });
            proc.Run(<string>cmdLine, undefined, { cwd: this.getProjectRoot().path });
        });
    }

    protected onToolchainChanged() {
        /* check toolchain is installed ? */
        this.checkAndNotifyInstallToolchain();
    }

    protected onUploaderChanged() {
        //TODO
    }

    onBuilderConfigChanged(): void {
        this.dependenceManager.flushToolchainDep();
        this.forceUpdateCpptoolsConfig();
    }

    onSourceCompilerOptionsChanged(): void {
        this.forceUpdateCpptoolsConfig();
    }

    protected abstract onComponentUpdate(updateList: ComponentUpdateItem[]): void;

    protected abstract onPrjConfigChanged(type: ProjectConfigEvent): void;

    protected abstract onSourceRootChanged(e: SourceChangedEvent): void;

    protected abstract onDeviceChanged(oledDevice?: CurrentDevice): void;

    protected abstract onPackageChanged(): void;

    protected abstract onTargetChanged(info: { name: string, isNew?: boolean }): void;

    protected abstract onEideDirChanged(evt: 'changed' | 'renamed', file: File): void;

    //-----------------------------------------------------------

    public abstract notifyUpdateSourceRefs(toolchain: ToolchainName | undefined): void;

    public abstract getSourceRefs(file: File): File[];

    public abstract getCpptoolsConfig(): CppConfigItem;

    //-----------------------------------------------------------

    public abstract createBase(option: CreateOptions, createNewPrjFolder?: boolean): BaseProjectInfo;

    protected abstract create(option: CreateOptions): File;

    abstract ExportToKeilProject(): File | undefined;

    static NewProject(): AbstractProject {
        return new EIDEProject();
    }
}

class EIDEProject extends AbstractProject {

    //////////////////////////////// Event handler ///////////////////////////////////

    protected onComponentUpdate(updateList: ComponentUpdateItem[]): void {

        const packInfo = this.packManager.GetPack();
        if (packInfo) {

            vscode.window.withProgress({
                title: `${packInfo.name}`,
                location: vscode.ProgressLocation.Notification
            }, (progress) => {
                return new Promise<void>((resolve) => {

                    const inc = 1 / updateList.length;
                    this.GetConfiguration().beginCacheEvents();

                    updateList.forEach((compItem, index) => {

                        this.dependenceManager.UninstallComponent(packInfo.name, compItem.name);

                        if (compItem.state === ComponentUpdateType.Expired) { // if need reinstalled
                            const comp = this.packManager.FindComponent(compItem.name);
                            if (comp) {
                                try {
                                    this.dependenceManager.InstallComponent(packInfo.name, comp);
                                } catch (error) {
                                    GlobalEvent.log_warn(error);
                                }
                            }
                        }

                        progress.report({
                            increment: inc,
                            message: `Updating components ${index + 1}/${updateList.length}: ${compItem.name}`
                        });
                    });

                    this.GetConfiguration().endCachedEvents();

                    resolve();
                });
            });
        }
    }

    protected onPrjConfigChanged(event: ProjectConfigEvent): void {

        switch (event.type) {
            case 'srcRootAdd':
                this.sourceRoots.add(<string>event.data);
                this.emit('dataChanged', 'files');
                this.UpdateCppConfig();
                break;
            case 'srcRootRemoved':
                this.sourceRoots.remove(<string>event.data);
                this.emit('dataChanged', 'files');
                this.UpdateCppConfig();
                break;
            case 'compiler':
                this.emit('dataChanged', 'compiler');
                this.UpdateCppConfig();
                break;
            case 'uploader':
                this.emit('dataChanged', 'uploader');
                break;
            case 'dependence':
                this.emit('dataChanged', 'dependence');
                this.UpdateCppConfig();
                break;
            case 'projectFileChanged':
                console.log(`eide project file changed: ${this.getProjectFile().path}`);
                this.emit('projectFileChanged');
                break;
            default:
                this.emit('dataChanged');
                break;
        }
    }

    protected onSourceRootChanged(type: SourceChangedEvent): void {
        switch (type) {
            case 'dataChanged':
                // update to config
                const prjConfig = this.GetConfiguration();
                prjConfig.config.srcDirs = this.getSourceRootFolders().map(folder => folder.fileWatcher.file.path);
                // update cpp config
                this.UpdateCppConfig();
                this.emit('dataChanged', 'files');
                break;
            case 'folderStatusChanged':
            case 'folderChanged':
                this.UpdateCppConfig();
                this.emit('dataChanged', 'files');
                break;
            default:
                this.emit('dataChanged', 'files');
                break;
        }
    }

    protected onDeviceChanged(oldDevice?: CurrentDevice | undefined): void {

        const prjConfig = this.GetConfiguration();
        const cConfig = prjConfig.compileConfigModel;

        // project type is ARM
        if (cConfig instanceof ArmBaseCompileConfigModel) {

            const newDevInfo = this.GetPackManager().getCurrentDevInfo();

            // clear old device
            if (oldDevice) {
                const dev = this.packManager.getCurrentDevInfo(oldDevice);
                const define = dev?.define?.split(/ |,/g);
                if (define && newDevInfo) { // if we switch device, remove old device macros 
                    this.GetConfiguration().CustomDep_RemoveFromDefineList(define);
                }
            }

            // update new device
            if (newDevInfo) {

                // update compile options
                cConfig.SetKeyValue('cpuType', newDevInfo.core || 'Cortex-M3');

                // update device, set macro
                prjConfig.config.deviceName = newDevInfo.name;
                if (newDevInfo.define) {
                    this.GetConfiguration().CustomDep_AddAllFromDefineList(newDevInfo.define.split(/ |,/g));
                }
            }

            this.emit('dataChanged', 'pack');
        }
    }

    protected onPackageChanged(): void {
        const prjConfig = this.GetConfiguration();
        const packDir = this.GetPackManager().GetPackDir();
        prjConfig.config.packDir = packDir ? (this.ToRelativePath(packDir.path) || null) : null;
        if (!this.GetPackManager().getCurrentDevInfo())
            prjConfig.config.deviceName = null;
        this.dependenceManager.Refresh();
        this.emit('dataChanged', 'pack');
    }

    protected onTargetChanged(t: { name: string, isNew?: boolean }): void {
        this.onSrcExtraOptionsChanged('changed');
        if (t.isNew) this.Save();
    }

    protected onEideDirChanged(evt: 'changed' | 'renamed', file: File): void {

        const target = this.getCurrentTarget().toLowerCase();

        if (evt == 'changed') {

            // source extra compiler args changed
            const cfgFile = File.fromArray([this.getEideDir().path, `${target}.files.options.yml`]);
            if (file.path == cfgFile.path && cfgFile.IsFile()) {
                this.onSrcExtraOptionsChanged(evt);
            }

            // project env changed
            if (file.name == this.getEnvFile(true).name) {
                this.UpdateCppConfig(); // trigger cpptools config update
            }
        }
    }

    ////////////////////////////////

    protected srcExtraCompilerConfig: SourceExtraCompilerOptionsCfg | undefined;

    private onSrcExtraOptionsChanged(evt: 'changed' | 'renamed') {
        this.srcExtraCompilerConfig = this.getSourceExtraArgsCfg();
        this.emit('cppConfigChanged');
    }

    private getExtraCompilerOptionsBySrcFile(srcPath: string, vPath?: string): string[] | undefined {

        const allArgs = this.getExtraArgsForSource(srcPath, vPath, this.getSourceExtraArgsCfg());
        if (!allArgs)
            return undefined;

        const argsList: string[] = [];

        for (const expr in allArgs) {
            argsList.push(allArgs[expr] || '');
        }

        return argsList;
    }

    //////////////////////////////// source refs ///////////////////////////////////

    private srcRefMap: Map<string, File[]> = new Map();

    public async notifyUpdateSourceRefs(toolchain_: ToolchainName | undefined) {

        /* clear old */
        this.srcRefMap.clear();

        /* check source references is enabled ? */
        if (!SettingManager.GetInstance().isDisplaySourceRefs()) {
            return;
        }

        let compiler_cmd_db: CompilerCommandsDatabaseItem[] = [];
        let generate_dep_file: ((cmd_db: CompilerCommandsDatabaseItem[], srcpath: string, deppath: string) => Promise<void>) | undefined;

        // for COSMIC STM8, we need manual generate .d files
        try {
            if (this.getToolchain().name == 'COSMIC_STM8') {
                const compilerDBFile = File.fromArray([this.getOutputFolder().path, 'compile_commands.json']);
                if (compilerDBFile.IsFile()) {
                    compiler_cmd_db = jsonc.parse(compilerDBFile.Read());
                    generate_dep_file = (cmd_db: CompilerCommandsDatabaseItem[], srcpath: string, deppath: string): Promise<void> => {
                        return new Promise((resolve) => {
                            let idx = cmd_db.findIndex((e) => e.file == srcpath);
                            if (idx == -1) { resolve(); return; }
                            let cmd_item = cmd_db[idx];
                            let command = cmd_item.command.replace('-co', '-sm -co');
                            child_process.exec(command, { cwd: cmd_item.directory }, (error: child_process.ExecException | null, stdout: string, stderr: string) => {
                                if (error) {
                                    GlobalEvent.log_warn(`Failed to make '${deppath}', msg: ${(<Error>error).message}`);
                                    try { fs.unlinkSync(deppath) } catch (error) { } // del old .d file
                                    resolve();
                                } else {
                                    fs.writeFileSync(deppath, stdout);
                                    resolve();
                                }
                            });
                        });
                    };
                }
            }
        } catch (error) {
            GlobalEvent.log_warn(error);
        }

        const toolName = toolchain_ || this.getToolchain().name;

        const outFolder = this.getOutputFolder();
        const refListFile = File.fromArray([outFolder.path, 'ref.json']);

        if (!refListFile.IsFile()) {
            return; /* no refs list file, exit */
        }

        try {
            const refMap = JSON.parse(refListFile.Read());
            for (const srcpath in refMap) {
                const refFile = new File((<string>refMap[srcpath]).replace(/\.[^\\\/\.]+$/, '.d'));
                if (generate_dep_file) await generate_dep_file(compiler_cmd_db, srcpath, refFile.path);
                if (!refFile.IsFile()) continue;
                const refs = this.parseRefFile(refFile, toolName).filter(p => p != srcpath);
                this.srcRefMap.set(srcpath, refs.map((path) => new File(path)));
            }
        } catch (error) {
            GlobalEvent.log_warn(error);
        }

        // notify update src view
        this.emit('dataChanged', 'files');
    }

    public getSourceRefs(file: File): File[] {
        return this.srcRefMap.get(file.path) || [];
    }

    public getSourceRefsAll(): string[] {
        const allHeaders: string[] = [];
        this.srcRefMap.forEach(v => v.forEach(f => allHeaders.push(f.path)));
        return ArrayDelRepetition(allHeaders);
    }

    private whitespaceMatcher = /(?<![\\:]) /;

    private gnu_parseRefLines(lines: string[]): string[] {

        const resultList: string[] = [];

        for (let i = 0; i < lines.length; i++) {

            let line = lines[i].replace(/\\\s*$/, '').trim(); // remove char '\' end of line

            if (i == 0) { // first line is makefile dep format: '<obj>: <deps>'
                let sepIndex = line.indexOf(": ");
                if (sepIndex > 0) line = line.substring(sepIndex + 1).trim();
                else continue; /* line is invalid, skip */
            }

            const subLines = line.split(this.whitespaceMatcher);

            for (const headerName of subLines) {
                if (headerName == '') continue;
                resultList.push(this.ToAbsolutePath(headerName
                    .replace(/\\ /g, " ")
                    .replace(/\\:/g, ":")));
            }
        }

        return ArrayDelRepetition(resultList.slice(1));
    }

    private ac5_parseRefLines(lines: string[], startIndex: number = 1): string[] {

        const resultList: string[] = [];

        for (let i = startIndex; i < lines.length; i++) {
            const sepIndex = lines[i].indexOf(": ");
            if (sepIndex > 0) {
                const line = lines[i].substring(sepIndex + 1)
                    .replace(/\\ /g, " ")
                    .replace(/\\:/g, ":").trim();
                resultList.push(this.ToAbsolutePath(line));
            }
        }

        return ArrayDelRepetition(resultList);
    }

    private parseRefFile(dFile: File, toolchain: ToolchainName): string[] {

        let cont: string | undefined;

        if (ResManager.getLocalCodePage() == '936') { // win32 gbk
            cont = iconv.decode(fs.readFileSync(dFile.path), '936');
        } else {
            cont = fs.readFileSync(dFile.path, 'utf8');
        }

        const lines: string[] = cont
            .split(/\r\n|\n/)
            .filter((line) => line.trim() != '');

        switch (toolchain) {
            case "AC5":
                return this.ac5_parseRefLines(lines);
            case "IAR_ARM":
            case "IAR_STM8":
                return this.ac5_parseRefLines(lines, 1);
            case "SDCC":
            case "AC6":
            case "GCC":
                return this.gnu_parseRefLines(lines);
            default:
                return this.gnu_parseRefLines(lines);
        }
    }

    //////////////////////////////// create project ///////////////////////////////////

    public createBase(option: CreateOptions, createNewPrjFolder: boolean = true): BaseProjectInfo {

        const rootDir: File = createNewPrjFolder
            ? File.fromArray([option.outDir.path, option.name])
            : option.outDir;

        rootDir.CreateDir(true);

        const wsFile = File.from(rootDir.path,
            (option.projectName || option.name) + AbstractProject.workspaceSuffix);

        // if workspace is existed, force delete it
        if (wsFile.IsFile()) { try { fs.unlinkSync(wsFile.path); } catch (error) { } }

        File.fromArray([wsFile.dir, AbstractProject.EIDE_DIR]).CreateDir(true);
        File.fromArray([wsFile.dir, AbstractProject.vsCodeDir]).CreateDir(true);

        const wsConfig = new WorkspaceConfiguration(wsFile).load();
        const eideFile = File.fromArray([wsFile.dir, AbstractProject.EIDE_DIR, AbstractProject.prjConfigName]);
        const prjConfig = new ProjectConfiguration(eideFile, option.type).load();

        // set project name
        prjConfig.config.name = option.projectName || AbstractProject.formatProjectName(option.name);

        return {
            rootFolder: rootDir,
            workspaceFile: wsFile,
            prjConfig: prjConfig
        };
    }

    protected create(option: CreateOptions): File {
        const baseInfo = this.createBase(option);
        baseInfo.prjConfig.config.name = option.projectName || AbstractProject.formatProjectName(option.name);
        baseInfo.prjConfig.config.outDir = 'build';
        baseInfo.prjConfig.config.srcDirs = [];
        baseInfo.prjConfig.Save();
        return baseInfo.workspaceFile;
    }

    ExportToKeilProject(): File | undefined {

        let keilFile: File;

        const prjConfig = this.GetConfiguration().config;

        if (!['ARM', 'C51'].includes(prjConfig.type)) { // only support for ARM, C51 project
            throw new Error(`only support for 'ARM', 'C51' project`);
        }

        const keilSuffix = prjConfig.type === 'C51' ? 'uvproj' : 'uvprojx';
        const suffixFilter = [new RegExp('\\.' + keilSuffix + '$', 'i')];

        // local keil file
        const localKeilFile = File.fromArray([this.GetRootDir().path, `${prjConfig.name}.${keilSuffix}`]);

        // get from project root folder
        if (localKeilFile.IsFile()) {
            keilFile = localKeilFile;
        } else {
            const keilFileList = ResManager.GetInstance().GetTemplateDir().GetList(suffixFilter, File.EXCLUDE_ALL_FILTER);
            const fIndex = keilFileList.findIndex((f) => { return f.noSuffixName === prjConfig.type; });
            if (fIndex === -1) { throw new Error('Not found \'' + prjConfig.type + '\' keil template file'); }
            keilFile = keilFileList[fIndex];
        }

        const keilParser = KeilParser.NewInstance(keilFile, prjConfig.type === 'C51' ? 'c51' : 'arm');

        let cDevice: CurrentDevice | undefined;
        if (prjConfig.type === 'ARM') { // only for ARM project
            cDevice = this.packManager.GetCurrentDevice();
        }

        let fileGroups: FileGroup[] = [];
        let halFiles: FileItem[] = [];

        this.getFileGroups().forEach((_group) => {

            // is filesystem source
            if (!AbstractProject.isVirtualSourceGroup(_group)) {
                const group = <ProjectFileGroup>_group;
                const rePath = this.ToRelativePath(group.dir.path);
                // combine HAL folder
                if (rePath && rePath.startsWith(PackageManager.PACK_DIR)) {
                    halFiles = halFiles.concat(group.files);
                } else {
                    fileGroups.push(<FileGroup>{
                        name: File.ToUnixPath(<string>rePath).toUpperCase(),
                        files: group.files,
                        disabled: group.disabled
                    });
                }
            }

            // is virtual source
            else {
                fileGroups.push({
                    name: _group.name.replace(`${VirtualSource.rootName}/`, ''), // remove '<virtual_root>/' header for keil
                    files: _group.files,
                    disabled: _group.disabled
                });
            }
        });

        if (halFiles.length > 0) {
            const index = fileGroups.findIndex((group) => group.name === 'HAL');
            if (index === -1) {
                fileGroups.push(<FileGroup>{
                    name: 'HAL',
                    files: halFiles
                });
            } else {
                fileGroups[index].files = fileGroups[index].files.concat(halFiles);
            }
        }

        // rm empty file groups for MDK
        fileGroups = fileGroups.filter(g => g.files.length > 0);

        // set keil xml
        keilParser.SetKeilXml(this, fileGroups, cDevice);

        return keilParser.Save(this.GetRootDir(), localKeilFile.noSuffixName);
    }

    //////////////////////////////// overrride ///////////////////////////////////

    private async runInstallScript(prjRoot: File, scriptName: string, title?: string): Promise<boolean> {

        const script = File.fromArray([prjRoot.path, AbstractProject.EIDE_DIR, scriptName]);
        const bash = ResManager.GetInstance().getMsysBash();
        if (!script.IsFile()) return true; // not found script, exit

        try {

            const proc = new ExeCmd();
            const cmd = `./${AbstractProject.EIDE_DIR}/${scriptName}`;

            title = title || script.noSuffixName;

            return vscode.window.withProgress({
                title: title,
                location: vscode.ProgressLocation.Notification
            }, (): Thenable<boolean> => {

                return new Promise((resolve) => {

                    proc.on('launch', () => {
                        GlobalEvent.emit('globalLog.append', os.EOL + `>>> running '${scriptName}' ...` + os.EOL + os.EOL);
                        GlobalEvent.emit('globalLog.show');
                    });

                    proc.on('line', (line) => GlobalEvent.emit('globalLog.append', line + os.EOL));
                    proc.on('errLine', (line) => GlobalEvent.emit('globalLog.append', line + os.EOL));
                    proc.on('error', (err) => GlobalEvent.log_error(err));

                    proc.on('close', (exitInf) => {
                        GlobalEvent.emit('globalLog.append', os.EOL + `process exited, exitCode: ${exitInf.code}` + os.EOL)
                        resolve(exitInf.code == 0);
                    });

                    proc.Run(cmd, undefined, { cwd: prjRoot.path, shell: bash?.path });
                });
            });

        } catch (error) {
            GlobalEvent.log_error(error)
            GlobalEvent.emit('globalLog.show');
        }

        return false;
    }

    protected async BeforeLoad(wsFile: File): Promise<void> {

        await super.BeforeLoad(wsFile);

        // run pre-install.sh
        if (this.isNewProject) {
            const name = 'pre-install.sh';
            const prjRoot = new File(wsFile.dir);
            const ok = await this.runInstallScript(prjRoot, name, `Running 'pre-install' task ...`);
            if (!ok) { throw new Error(`Run '${name}' failed !, please check logs in 'eide-log' output panel.`); }
        }
    }

    protected async AfterLoad(): Promise<void> {

        await super.AfterLoad();

        // register cfg watcher
        this.onSrcExtraOptionsChanged('changed'); // notify cpptools update now

        // init settings for new project
        if (this.isNewProject) {

            const workspaceConfig = this.GetWorkspaceConfig();
            const settings = workspaceConfig.config.settings;

            // --- eide settings
            // TODO

            // --- vscode settings

            if (settings['files.autoGuessEncoding'] === undefined) {
                settings['files.autoGuessEncoding'] = true;
            }

            if (settings['C_Cpp.default.configurationProvider'] === undefined) {
                settings['C_Cpp.default.configurationProvider'] = this.extensionId;
            }

            if (settings['C_Cpp.errorSquiggles'] == undefined ||
                settings['C_Cpp.errorSquiggles'] == 'Disabled') {
                settings['C_Cpp.errorSquiggles'] = "disabled";
            }

            // if (this.getToolchain().name == 'COSMIC_STM8') {
            //     settings["C_Cpp.intelliSenseEngine"] = "Tag Parser";
            // }

            // remove some c/c++ configs
            [
                'C_Cpp.default.intelliSenseMode',
                'C_Cpp.default.cppStandard',
                'C_Cpp.default.cStandard'
            ].forEach((key) => {
                if (settings[key]) {
                    settings[key] = undefined;
                }
            });

            const fileAssCfg: any = {
                ".eideignore": "ignore",
                "*.a51": "a51",
                "*.h": "c",
                "*.c": "c",
                "*.hxx": "cpp",
                "*.hpp": "cpp",
                "*.c++": "cpp",
                "*.cpp": "cpp",
                "*.cxx": "cpp",
                "*.cc": "cpp"
            };

            if (!settings['files.associations']) {
                settings['files.associations'] = fileAssCfg;
            } else {
                for (const key in fileAssCfg) {
                    if (!settings['files.associations'][key]) {
                        settings['files.associations'][key] = fileAssCfg[key];
                    }
                }
            }

            if (!settings['[yaml]']) {
                settings['[yaml]'] = {
                    "editor.insertSpaces": true,
                    "editor.tabSize": 4,
                    "editor.autoIndent": "advanced"
                };
            }

            // --- vscode tasks

            // append default task for new project
            try {
                const defTasks = [
                    {
                        "label": "build",
                        "type": "shell",
                        "command": "${command:eide.project.build}",
                        "group": "build",
                        "problemMatcher": []
                    },
                    {
                        "label": "flash",
                        "type": "shell",
                        "command": "${command:eide.project.uploadToDevice}",
                        "group": "build",
                        "problemMatcher": []
                    },
                    {
                        "label": "build and flash",
                        "type": "shell",
                        "command": "${command:eide.project.buildAndFlash}",
                        "group": "build",
                        "problemMatcher": []
                    },
                    {
                        "label": "rebuild",
                        "type": "shell",
                        "command": "${command:eide.project.rebuild}",
                        "group": "build",
                        "problemMatcher": []
                    },
                    {
                        "label": "clean",
                        "type": "shell",
                        "command": "${command:eide.project.clean}",
                        "group": "build",
                        "problemMatcher": []
                    }
                ];
                const tasksFile = File.fromArray([this.GetRootDir().path, AbstractProject.vsCodeDir, 'tasks.json']);
                if (!tasksFile.IsFile()) {
                    tasksFile.Write(JSON.stringify({
                        "version": "2.0.0",
                        "tasks": defTasks
                    }, undefined, 4));
                }
            } catch (error) {
                GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
            }

            // gen default 'settings.json'
            try {
                const settingsFile = File.fromArray([this.GetRootDir().path, AbstractProject.vsCodeDir, 'settings.json']);
                if (!settingsFile.IsFile()) { settingsFile.Write('{}'); }
            } catch (error) {
                // nothing todo
            }

            // add extension recommendation
            {
                let recommendExt: string[] = [
                    "cl.eide",
                    "keroc.hex-fmt",
                    "xiaoyongdong.srecord",
                    "hars.cppsnippets",
                    "zixuanwang.linkerscript",
                    "redhat.vscode-yaml",
                    "IBM.output-colorizer",
                    "cschlosser.doxdocgen",
                    "ms-vscode.vscode-serial-monitor",
                    "alefragnani.project-manager"
                ];

                const prjInfo = this.GetConfiguration().config;

                if (prjInfo.type == 'ARM') {
                    recommendExt.push(
                        "dan-c-underwood.arm",
                        "marus25.cortex-debug",
                    );
                }

                else if (prjInfo.type == 'C51') {
                    recommendExt.push('cl.stm8-debug');
                }

                if (workspaceConfig.config.extensions &&
                    workspaceConfig.config.extensions.recommendations instanceof Array) {
                    recommendExt = ArrayDelRepetition(recommendExt.concat(workspaceConfig.config.extensions.recommendations));
                }

                if (workspaceConfig.config.extensions == undefined) {
                    workspaceConfig.config.extensions = {};
                }

                workspaceConfig.config.extensions.recommendations = recommendExt;
            }

            // default .gitignore
            {
                const ignCont = [
                    '# dot files',
                    '/.vscode/launch.json',
                    '/.settings',
                    '/.eide/log',
                    '/' + ProjectConfiguration.USR_CTX_FILE_NAME,
                    '',
                    '# project out',
                    '/build', '/bin', '/obj', '/out',
                    '',
                    '# eide template',
                    '*.ept',
                    '*.eide-template',
                    ''
                ];

                const ignFile = File.fromArray([this.GetRootDir().path, '.gitignore']);
                if (!ignFile.IsFile()) {
                    ignFile.Write(ignCont.join(os.EOL));
                }
            }

            // default .clang-format
            {
                const fSrc = File.fromArray([ResManager.GetInstance().GetAppDataDir().path, '.clang-format']);
                const fDst = File.fromArray([this.GetRootDir().path, '.clang-format']);
                if (!fDst.IsFile() && fSrc.IsFile()) {
                    fs.copyFileSync(fSrc.path, fDst.path);
                }
            }

            workspaceConfig.Save(true);
        }

        /* update src refs */
        this.notifyUpdateSourceRefs(undefined);

        // !! we need deleted global c_cpp_properties.json !!
        {
            const cfgFile = File.fromArray([
                this.GetRootDir().path, '.vscode', AbstractProject.cppConfigName
            ]);

            if (cfgFile.IsFile()) {
                try {
                    if (this.isNewProject || this.isOldVersionProject) {
                        fs.unlinkSync(cfgFile.path);
                    } else {
                        const cfg = jsonc.parse(cfgFile.Read());
                        if (Array.isArray(cfg['configurations'])) {
                            const idx = cfg['configurations'].findIndex((item) => item['name'] == os.platform());
                            if (idx != -1 && cfg['configurations'][idx].configurationProvider == this.extensionId) {
                                fs.unlinkSync(cfgFile.path);
                            }
                        }
                    }
                } catch (error) {
                    //
                }
            }
        }

        // delete '.eide/log' folder
        if (this.isNewProject || this.isOldVersionProject) {
            const _d = File.from(this.getRootDir().path, '.eide', 'log');
            if (_d.IsDir()) {
                try {
                    platform.DeleteDir(_d);
                } catch (error) {
                    GlobalEvent.log_error(error);
                }
            }
        }

        // show warnings if we have
        setTimeout(async (rootFolder: File) => {
            try {
                for (const f of rootFolder.GetList([/importer\.warning\.txt$/], File.EXCLUDE_ALL_FILTER)) {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(f.ToUri()));
                    vscode.window.showTextDocument(doc, { preview: false, selection: doc.lineAt(0).range });
                    break;
                }
            } catch (error) {
                GlobalEvent.emit('error', error);
            }
        }, 1000, this.GetRootDir());

        // run post-install.sh
        if (this.isNewProject) {
            this.runInstallScript(this.GetRootDir(), 'post-install.sh', `Running 'post-install' task ...`)
                .then((done) => {
                    if (!done) {
                        const msg = `Run 'post-install' failed !, please check logs in 'eide-log' output panel.`;
                        vscode.window.showWarningMessage(msg);
                        GlobalEvent.emit('globalLog.show');
                    }
                });
        }

        // save now
        this.Save(false, 100);

        if (this.GetConfiguration().needReloadProject) {
            notifyReloadWindow(view_str$prompt$reloadForOldProject);
        }
    }

    ////////////////////////////////// cpptools intellisence provider ///////////////////////////////////

    name: string = 'eide';
    extensionId: string = 'cl.eide';

    // virtual source path list (!! must be real absolute path !!)
    //      key: fsPath
    //      val: virtual path
    private vSourceList: Map<string, string> = new Map();

    private cppToolsConfig: CppConfigItem = {
        name: os.platform(),
        includePath: [],
        defines: []
    };

    private __cpptools_updateTimeout: NodeJS.Timeout | undefined;

    getCpptoolsConfig(): CppConfigItem {
        return <CppConfigItem>deepCloneObject(this.cppToolsConfig);
    }

    forceUpdateCpptoolsConfig(): void {
        this.UpdateCppConfig();
    }

    UpdateCppConfig() {

        // if updater not in running, create it
        if (this.__cpptools_updateTimeout == undefined) {
            this.__cpptools_updateTimeout =
                setTimeout(() => {
                    try {
                        this.doUpdateCpptoolsConfig();
                        this.doUpdateCompilerDatabase();
                    } catch (error) {
                        GlobalEvent.emit('msg', ExceptionToMessage(error, 'Hidden'));
                    }
                }, 1000);
        }

        // we already have a updater in running, now delay it
        else {
            this.__cpptools_updateTimeout.refresh();
        }
    }

    private _getCompilerIntrDefsForCpptools<T extends BuilderConfigData>(
        toolchain: IToolchian, builderCfg: T, builderOpts: BuilderOptions): string[] {

        if (isGccFamilyToolchain(toolchain.name) || toolchain.name == 'LLVM_ARM') {
            // 对于 gcc/clang 系列，C/C++ 具备自动解析宏定义功能，因此无需返回任何宏定义
            return [];
        } else {
            let defines = toolchain.getInternalDefines(builderCfg, builderOpts);
            // 对于 AC5 和 AC6, 我们仅仅返回几个动态的宏，其他的宏定义暂时丢弃，
            // 因为这可能会导致 Cpptools 无法识别，另外我们已经在 xxx_intr.h 中预定义了一些宏
            if (toolchain.name == 'AC5') {
                const filterkeys = [
                    '__ARMCC_VERSION',
                    '__TARGET_CPU_',
                    '__TARGET_FPU_', '__SOFTFP',
                    '__TARGET_ARCH',
                    '__thumb',
                    '__MICROLIB',
                    '__STDC_VERSION'
                ];
                defines = defines.filter(d => filterkeys.some(k => d.name.startsWith(k)));
            } else if (toolchain.name == 'AC6') {
                const filterkeys = [
                    '__ARM_PCS_VFP'
                ];
                defines = defines.filter(d => filterkeys.some(k => d.name.startsWith(k)));
            }
            return defines.map(d => `${d.name}=${d.value}`);
        }
    }

    private doUpdateCpptoolsConfig() {

        const builderOpts = this.getBuilderOptions();
        const toolchain = this.getToolchain();
        const prjConfig = this.GetConfiguration();

        // get project includes and defines
        const depMerge = prjConfig.GetAllMergeDep();
        const defMacros: string[] = ['__VSCODE_CPPTOOL']; // it's for internal force include header
        const intrDefs = this._getCompilerIntrDefsForCpptools(toolchain, <any>prjConfig.config.compileConfig, builderOpts);
        const defLi = defMacros.concat(depMerge.defineList, intrDefs);
        depMerge.incList = depMerge.incList.concat(this.getSourceIncludeList()).map(p => this.ToAbsolutePath(p));

        // update includes and defines 
        this.cppToolsConfig.includePath = ArrayDelRepetition(depMerge.incList.map((_path) => File.ToUnixPath(platform.realpathSync(_path))));
        this.cppToolsConfig.defines = ArrayDelRepetition(defLi);

        // update intellisence info
        {
            // clear old value
            this.cppToolsConfig.compilerArgs = undefined;
            this.cppToolsConfig.cCompilerArgs = undefined;
            this.cppToolsConfig.cppCompilerArgs = undefined;

            // preset cpu info for arm project
            if (prjConfig.compileConfigModel instanceof ArmBaseCompileConfigModel) {
                builderOpts.global = builderOpts.global || {};
                const cpuName: string = prjConfig.compileConfigModel.data.cpuType.toLowerCase();
                const fpuName: string = prjConfig.compileConfigModel.data.floatingPointHardware;
                const archExt: string = prjConfig.compileConfigModel.data.archExtensions || '';
                // 将 cpu 信息作为上下文传递给 updateCppIntellisenceCfg，
                // 以便 toolchain 能够生成合适的 compiler args 用于执行 Intellisence
                builderOpts.global['_cpuName'] = cpuName;
                builderOpts.global['_fpuType'] = fpuName;
                builderOpts.global['_archExt'] = archExt;
            }

            // update
            toolchain.updateCppIntellisenceCfg(builderOpts, this.cppToolsConfig);

            // merge c compiler args
            if (this.cppToolsConfig.compilerArgs || this.cppToolsConfig.cCompilerArgs) {

                this.cppToolsConfig.cCompilerArgs = (this.cppToolsConfig.compilerArgs || [])
                    .concat(this.cppToolsConfig.cCompilerArgs || []);

                this.cppToolsConfig.cCompilerArgs = this.cppToolsConfig.cCompilerArgs.map((param) => {
                    return param.replace('${c_cppStandard}', this.cppToolsConfig.cStandard || 'c11');
                });
            }

            // merge c++ compiler args
            if (this.cppToolsConfig.compilerArgs || this.cppToolsConfig.cppCompilerArgs) {

                this.cppToolsConfig.cppCompilerArgs = (this.cppToolsConfig.compilerArgs || [])
                    .concat(this.cppToolsConfig.cppCompilerArgs || []);

                this.cppToolsConfig.cppCompilerArgs = this.cppToolsConfig.cppCompilerArgs.map((param) => {
                    return param.replace('${c_cppStandard}', this.cppToolsConfig.cppStandard || 'c++11');
                });
            }

            // replace var value for global args
            if (this.cppToolsConfig.compilerArgs) {
                this.cppToolsConfig.compilerArgs = (<string[]>this.cppToolsConfig.compilerArgs).map((param) => {
                    return param.replace('${c_cppStandard}', this.cppToolsConfig.cStandard || 'c99');
                });
            }
        }

        // replace env variables for config
        {
            this.cppToolsConfig.defines = this.cppToolsConfig.defines.map((arg) => {
                return this.replacePathEnv(arg);
            });

            if (this.cppToolsConfig.compilerArgs) {
                this.cppToolsConfig.compilerArgs = (<string[]>this.cppToolsConfig.compilerArgs).map((arg) => {
                    return this.replacePathEnv(arg);
                });
            }

            if (this.cppToolsConfig.cCompilerArgs) {
                this.cppToolsConfig.cCompilerArgs = (<string[]>this.cppToolsConfig.cCompilerArgs).map((arg) => {
                    return this.replacePathEnv(arg);
                });
            }

            if (this.cppToolsConfig.cppCompilerArgs) {
                this.cppToolsConfig.cppCompilerArgs = (<string[]>this.cppToolsConfig.cppCompilerArgs).map((arg) => {
                    return this.replacePathEnv(arg);
                });
            }
        }

        // filter unhandled env variables
        {
            const varMatcher = /\$\{.+\}/;

            if (this.cppToolsConfig.compilerArgs) {
                this.cppToolsConfig.compilerArgs = this.cppToolsConfig.compilerArgs.filter(a => !varMatcher.test(a));
            }

            if (this.cppToolsConfig.cCompilerArgs) {
                this.cppToolsConfig.cCompilerArgs = this.cppToolsConfig.cCompilerArgs.filter(a => !varMatcher.test(a));
            }

            if (this.cppToolsConfig.cppCompilerArgs) {
                this.cppToolsConfig.cppCompilerArgs = this.cppToolsConfig.cppCompilerArgs.filter(a => !varMatcher.test(a));
            }
        }

        // update source browse path
        let srcBrowseFolders: string[] = [];

        this.vSourceList.clear();
        this.getVirtualSourceManager().traverse((vFolder) => {
            vFolder.folder.files.forEach((vFile) => {
                const fAbsPath = platform.realpathSync(this.ToAbsolutePath(vFile.path)); // resolve symbol link
                const virtPath = `${vFolder.path}/${NodePath.basename(vFile.path)}`;
                this.vSourceList.set(fAbsPath, virtPath);
                srcBrowseFolders.push(`${File.ToUnixPath(NodePath.dirname(fAbsPath))}/*`);
            });
        });

        this.getNormalSourceManager().getFileGroups().forEach(fGrp => {
            if (fGrp.disabled) { return; } // skip disabled group
            fGrp.files.forEach(fItem => {
                if (fItem.disabled) { return; } // skip disabled file
                srcBrowseFolders.push(`${File.ToUnixPath(platform.realpathSync(fItem.file.dir))}/*`);
            });
        });

        // update includes to browse info
        this.cppToolsConfig.browse = {
            limitSymbolsToIncludedHeaders: true,
            path: ArrayDelRepetition(srcBrowseFolders)
        };

        // compiler path
        this.cppToolsConfig.compilerPath = this.getToolchain().getGccFamilyCompilerPathForCpptools();
        if (this.cppToolsConfig.compilerPath == undefined) {
            // Set "compilerPath" to "" to disable detection of system includes and defines.
            this.cppToolsConfig.compilerPath = "";
        }

        // update forceinclude headers
        this.cppToolsConfig.forcedInclude = [];

        toolchain.getForceIncludeHeaders()?.forEach((f_path) => {
            this.cppToolsConfig.forcedInclude?.push(File.normalize(f_path));
        });

        SettingManager.GetInstance().getForceIncludeList().forEach((path) => {
            this.cppToolsConfig.forcedInclude?.push(this.ToAbsolutePath(path));
        });

        // notify config changed
        this.emit('cppConfigChanged');
        console.log(this.cppToolsConfig);

        // clear timeout obj
        this.__cpptools_updateTimeout = undefined;
    }

    canProvideConfiguration(uri: vscode.Uri, token?: vscode.CancellationToken | undefined): Thenable<boolean> {

        return new Promise((resolve) => {

            const realPath = platform.realpathSync(uri.fsPath);
            const lowcasePath = uri.fsPath.toLowerCase();
            const prjRoot = platform.realpathSync(this.GetRootDir().path);
            const allIncPaths = this.cppToolsConfig.includePath.map(p => File.ToLocalPath(p.toLowerCase()));

            // filter source files that can provide
            let result: boolean =
                realPath.startsWith(prjRoot) ||                      // All source files in current workspace
                allIncPaths.some(p => lowcasePath.startsWith(p)) ||  // All files in IncludePaths
                this.vSourceList.has(realPath) ||                    // All virtual source files
                this.sourceRoots.isIncludes(realPath);               // All source files in linked source folders

            // other .h files
            if (!result && AbstractProject.headerFilter.test(lowcasePath)) {
                const allHeaders = this.getSourceRefsAll().map(p => File.ToLocalPath(p.toLowerCase()));
                result = result ||
                    allHeaders.some(p => p == lowcasePath) || // All .h files for this project
                    lowcasePath.startsWith(this.getToolchain().getToolchainDir().path.toLowerCase()); // All .h files in toolchain dir
            }

            resolve(result);
        });
    }

    private readonly cFileMatcher = /\.(?:c|h)$/i;

    provideConfigurations(uris: vscode.Uri[], token?: vscode.CancellationToken | undefined): Thenable<SourceFileConfigurationItem[]> {

        return new Promise((resolve) => {

            resolve(uris.map((uri) => {

                let fileArgs: string[] | undefined;

                if (this.cppToolsConfig.compilerPath) { // if compiler is available, parse file options
                    const filePath = platform.realpathSync(uri.fsPath);
                    const vPath = this.vSourceList.get(filePath);
                    fileArgs = this.getExtraCompilerOptionsBySrcFile(filePath, vPath);
                }

                // c files
                if (this.cFileMatcher.test(uri.fsPath)) {

                    let compilerArgs = this.cppToolsConfig.cCompilerArgs;
                    if (fileArgs) {
                        compilerArgs = (compilerArgs || []).concat(fileArgs);
                    }

                    return {
                        from_: `${this.getProjectName()}:${this.getCurrentTarget()} (${this.getUid()})`,
                        uri: uri,
                        configuration: {
                            standard: <any>this.cppToolsConfig.cStandard,
                            includePath: this.cppToolsConfig.includePath,
                            defines: this.cppToolsConfig.defines,
                            forcedInclude: this.cppToolsConfig.forcedInclude,
                            compilerPath: this.cppToolsConfig.compilerPath,
                            compilerArgs: compilerArgs
                        }
                    };
                }

                // c++ files
                else {

                    const compilerArgs: string[] = [];
                    const compilerPath = this.getToolchain().getGccFamilyCompilerPathForCpptools('c++');

                    // We need to tell gcc compiler: this is a c++ file
                    if (compilerPath) {
                        compilerArgs.push('-xc++');
                    }

                    this.cppToolsConfig.cppCompilerArgs?.forEach(arg => compilerArgs.push(arg));
                    if (fileArgs) {
                        fileArgs.forEach(arg => compilerArgs.push(arg));
                    }

                    return {
                        from_: `${this.getProjectName()}:${this.getCurrentTarget()} (${this.getUid()})`,
                        uri: uri,
                        configuration: {
                            standard: <any>this.cppToolsConfig.cppStandard,
                            includePath: this.cppToolsConfig.includePath,
                            defines: this.cppToolsConfig.defines,
                            forcedInclude: this.cppToolsConfig.forcedInclude,
                            compilerPath: compilerPath || "",
                            compilerArgs: compilerArgs
                        }
                    };
                }
            }));
        });
    }

    canProvideBrowseConfigurationsPerFolder(token?: vscode.CancellationToken | undefined): Thenable<boolean> {
        return new Promise((resolve) => {
            resolve(true);
        });
    }

    provideFolderBrowseConfiguration(uri: vscode.Uri, token?: vscode.CancellationToken | undefined): Thenable<WorkspaceBrowseConfiguration | null> {
        return new Promise((resolve) => {
            const prjRoot = this.GetRootDir().path;
            if (platform.realpathSync(prjRoot) == platform.realpathSync(uri.fsPath)) {
                resolve({
                    browsePath: this.cppToolsConfig.browse?.path || [],
                    compilerPath: this.cppToolsConfig.compilerPath,
                    compilerArgs: this.cppToolsConfig.compilerArgs
                });
            } else {
                resolve(null);
            }
        });
    }

    canProvideBrowseConfiguration(token?: vscode.CancellationToken | undefined): Thenable<boolean> {
        return new Promise((resolve) => {
            resolve(false);
        });
    }

    provideBrowseConfiguration(token?: vscode.CancellationToken | undefined): Thenable<WorkspaceBrowseConfiguration | null> {
        return new Promise((resolve) => {
            resolve(null);
        });
    }

    dispose() {
        // nothing todo
    }
}
