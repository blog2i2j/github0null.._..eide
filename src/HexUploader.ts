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

import { AbstractProject } from "./EIDEProject";
import { ResManager } from "./ResManager";
import { File } from "../lib/node-utility/File";
import { GlobalEvent } from "./GlobalEvents";
import { SettingManager } from "./SettingManager";
import { CmdLineHandler } from "./CmdLineHandler";
import { gotoSet_text, view_str$download_software } from "./StringTable";
import { EncodingConverter } from "./EncodingConverter";
import { ToolchainName, ToolchainManager } from "./ToolchainManager";
import { runShellCommand, deepCloneObject, probers_install } from './utility';
import { WorkspaceManager } from "./WorkspaceManager";

import * as child_process from "child_process";
import * as vscode from "vscode";
import * as NodePath from 'path';
import * as os from "os";
import * as fs from 'fs';
import * as ini from 'ini';
import { ResInstaller } from "./ResInstaller";
import { newMessage } from "./Message";
import { concatSystemEnvPath, exeSuffix, prependToSysEnv, osType, appendToSysEnv, userhome } from "./Platform";
import { StatusBarManager } from "./StatusBarManager";

let _mInstance: HexUploaderManager | undefined;

export type HexUploaderType = 'JLink' | 'STVP' | 'STLink' | 'stcgal' | 'pyOCD' | 'OpenOCD' | 'probe-rs' | 'Custom';

export interface UploadOption {
    // program file path
    // format: "<file1_path>[,addr1];<file2_path>[,addr2]"
    bin: string;
}

export interface HexUploaderInfo {
    label?: string;
    type: HexUploaderType;
    description?: string;
    filters?: ToolchainName[]; // if undefined, not have filter
}

export class HexUploaderManager {

    private uploaderList: HexUploaderInfo[] = [];

    private constructor() {

        const arm_toolchains   = ToolchainManager.getInstance().getToolchainNameList('ARM');
        const riscv_toolchains = ToolchainManager.getInstance().getToolchainNameList('RISC-V');

        this.uploaderList = [
            {
                type: 'JLink',
                description: 'for Cortex-M chips, only JLink interface',
                filters: arm_toolchains.concat(riscv_toolchains, ['ANY_GCC'])
            },
            {
                type: 'STLink',
                description: 'for STM32 chips, only STLink interface',
                filters: arm_toolchains
            },
            {
                type: 'pyOCD',
                description: 'for Cortex-M chips',
                filters: arm_toolchains.concat(riscv_toolchains, ['ANY_GCC'])
            },
            {
                type: 'OpenOCD',
                description: 'for Cortex-M chips',
                filters: arm_toolchains.concat(riscv_toolchains, ['ANY_GCC'])
            },
            {
                type: 'probe-rs',
                description: 'for ARM, RISC-V devices',
                filters: arm_toolchains.concat(riscv_toolchains, ['ANY_GCC'])
            },
            // 8/16 bits mcus
            {
                type: 'stcgal',
                description: 'for STC chips',
                filters: ['Keil_C51', 'SDCC', 'GNU_SDCC_MCS51']
            },
            {
                type: 'STVP',
                description: 'for STM8 chips, only STLink interface',
                filters: ['IAR_STM8', 'SDCC', 'COSMIC_STM8']
            },
            // custom
            {
                type: 'Custom',
                label: 'Custom CLI',
                description: 'download program by custom command-line'
            }
        ];
    }

    getUploaderLabelByName(uploaderName: HexUploaderType): string {

        const index = this.uploaderList.findIndex((info) => {
            return info.type == uploaderName;
        });

        if (index != -1) {
            return this.uploaderList[index].label || uploaderName;
        }

        return uploaderName;
    }

    getUploaderList(toolType: ToolchainName): HexUploaderInfo[] {
        return this.uploaderList.filter((info) => {
            return info.filters ? info.filters.includes(toolType) : true;
        });
    }

    createUploader(prj: AbstractProject): HexUploader<any> {
        switch (prj.GetConfiguration().config.uploader) {
            case 'JLink':
                return new JLinkUploader(prj);
            case 'STLink':
                return new STLinkUploader(prj);
            case 'stcgal':
                return new StcgalUploader(prj);
            case 'STVP':
                return new STVPHexUploader(prj);
            case 'pyOCD':
                return new PyOCDUploader(prj);
            case 'OpenOCD':
                return new OpenOCDUploader(prj);
            case 'probe-rs':
                return new ProbeRSUploader(prj);
            case 'Custom':
                return new CustomUploader(prj);
            default:
                throw new Error('Invalid uploader type !');
        }
    }

    static getInstance(): HexUploaderManager {
        if (_mInstance === undefined) {
            _mInstance = new HexUploaderManager();
        }
        return _mInstance;
    }
}

//------------------------------------------------------

interface UploaderPreData<T> {

    isOk: boolean | Error;

    params?: T;
}

export interface FlashProgramFile {

    path: string;

    addr?: string;
};

export abstract class HexUploader<InvokeParamsType> {

    abstract readonly toolType: HexUploaderType;

    protected DEF_BIN_ADDR: string = '0x00000000';

    protected project: AbstractProject;
    protected shellPath: string | undefined;

    constructor(prj: AbstractProject) {
        this.project = prj;
        this.shellPath = ResManager.checkWindowsShell() ? undefined : ResManager.GetInstance().getCMDPath();
    }

    async upload(eraseAll?: boolean) {

        const dat = await this._prepare(eraseAll);

        if (dat.isOk === false) { // canceled
            return;
        }

        else if (dat.isOk instanceof Error) { // has a error
            throw dat.isOk;
        }

        // start program
        this._launch(dat.params);
    }

    protected getUploadOptions<T extends UploadOption>(): T {
        return JSON.parse(JSON.stringify(this.project.GetConfiguration().uploadConfigModel.data));
    }

    protected parseProgramFiles<T extends UploadOption>(options: T): FlashProgramFile[] {

        const result: FlashProgramFile[] = [];
        const matcher = /(?<path>[^,]+)(?:,(?<addr>0x[a-f0-9]+))?/i;

        const formatBinFilePath = (p: string): string => {
            if (this.toolType == 'STLink') {
                // 对于不支持中文路径的烧录器，暂时不要转换为绝对路径
                return this.project.resolveEnvVar(p);
            } else {
                return this.project.toAbsolutePath(p);
            }
        };

        // if 'bin' path is empty, use default program path 
        if (options.bin.trim() === '') {

            // relative path with './' prefix
            const hexPath = [
                '.', this.project.getOutputDir(), this.project.getProjectName() + '.hex'
            ].join(File.sep);

            return [{ path: formatBinFilePath(hexPath) }];
        }

        options.bin.split(';').forEach((path) => {
            const m = matcher.exec(path);
            if (m && m.groups && m.groups['path']) {
                result.push({
                    path: formatBinFilePath(m.groups['path']),
                    addr: m.groups['addr']
                });
            }
        });

        return result;
    }

    resolveHexFilePathEnvs(input: string, programs: FlashProgramFile[]): string {

        const portList = ResManager.GetInstance().enumSerialPort();

        let commandLine = input
            .replace(/\$\{hexFile\}|\$\{binFile\}|\$\{programFile\}/ig, programs[0].path)
            .replace(/\$\{port\}/ig, portList[0] || '')
            .replace(/\$\{portList\}/ig, portList.join(' '));

        programs.forEach((file, index) => {

            commandLine = commandLine
                .replace(new RegExp(String.raw`\$\{hexFile\[${index}\]\}`, 'ig'), file.path)
                .replace(new RegExp(String.raw`\$\{binFile\[${index}\]\}`, 'ig'), file.path)
                .replace(new RegExp(String.raw`\$\{programFile\[${index}\]\}`, 'ig'), file.path);

            if (file.addr) {
                commandLine = commandLine
                    .replace(new RegExp(String.raw`\$\{binAddr\[${index}\]\}`, 'ig'), file.addr || '0x00000000')
            }
        });

        return commandLine;
    }

    getAllProgramFiles(): FlashProgramFile[] {
        return this.parseProgramFiles(this.getUploadOptions<any>());
    }

    async executeShellCommand(title: string, commandLine: string, env?: any, useTerminal?: boolean, cwd?: string) {
        const silent = SettingManager.GetInstance().isSilentBuildOrFlash();
        const etask = await runShellCommand(title, commandLine, {
            source: 'eide.flasher',
            env: env,
            useTerminal: useTerminal,
            cwd: cwd,
            silent: silent
        });
        const bar = StatusBarManager.getInstance().get('flash');
        if (etask && bar) {
            bar.text = `$(loading~spin) Flashing`;
            bar.tooltip = `Command: ${commandLine}`;
        }
    }

    protected toAbsolute(_path: string): File | undefined {
        if (_path.trim() == '') return undefined;
        return new File(this.project.ToAbsolutePath(_path));
    }

    protected abstract _prepare(eraseAll?: boolean): Promise<UploaderPreData<InvokeParamsType>>;

    protected abstract _launch(params: InvokeParamsType | undefined): void;
}

//======================== uploader implement ==============================

/**
 * jlink programer
*/
export enum JLinkProtocolType {
    JTAG = 0,
    SWD = 1,
    FINE = 3,
    cJTAG = 7
}

export interface CPUInfo {
    vendor: string;
    cpuName: string;
}

export interface JLinkOptions extends UploadOption {

    baseAddr?: string;

    cpuInfo: CPUInfo;

    proType: JLinkProtocolType;

    speed?: number;

    otherCmds: string;
}

class JLinkUploader extends HexUploader<any> {

    toolType: HexUploaderType = 'JLink';

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string[]>> {

        if (!new File(SettingManager.GetInstance().getJlinkDir()).IsDir()) {
            await ResInstaller.instance().setOrInstallTools(this.toolType, `Not found 'JLink' install directory !`);
            return { isOk: false };
        }

        // create output dir
        const outFolder = new File(this.project.ToAbsolutePath(this.project.getOutputDir()));
        outFolder.CreateDir(true);
        const jlinkCommandsFile = File.fromArray([outFolder.path, 'commands.jlink']);

        const option = this.getUploadOptions<JLinkOptions>();
        const files = this.parseProgramFiles(option);

        // jlink cmd template
        let jlinkCommandtemplate: string = '${EIDE_JLINK_FLASHER_CMD}';
        const tFile = File.fromArray([this.project.getEideDir().path, 'jlink.flasher.cmd.template']);
        if (tFile.IsFile()) {
            jlinkCommandtemplate = tFile.Read();
        }

        // program cmds
        const flasherCmds: string[] = [];

        if (!eraseAll) {

            if (files.length == 0) {
                return { isOk: new Error(`no any program files !`) };
            }

            flasherCmds.push(
                'r',
                'halt'
            );

            files.forEach((file) => {
                if (/\.bin$/i.test(file.path)) {
                    const addr = file.addr || option.baseAddr
                    flasherCmds.push(`loadfile "${file.path}"${addr ? (`,${addr}`) : ''}`);
                } else {
                    flasherCmds.push(`loadfile "${file.path}"`);
                }
            });

            flasherCmds.push(
                'r',
                'go'
            );
        }

        // erase internal falsh
        else {
            flasherCmds.push(
                'r',
                'halt',
                'erase',
                'r'
            );
        }

        // replace vars
        jlinkCommandtemplate = jlinkCommandtemplate.replace(/\$\{EIDE_JLINK_FLASHER_CMD\}/g, flasherCmds.join(os.EOL));
        jlinkCommandtemplate = this.resolveHexFilePathEnvs(jlinkCommandtemplate, files);
        jlinkCommandtemplate = this.project.resolveEnvVar(jlinkCommandtemplate);
        jlinkCommandtemplate = jlinkCommandtemplate + os.EOL + 'exit'; // append 'exit' command

        const codePage = ResManager.getLocalCodePage();

        // write commands file
        if (codePage && EncodingConverter.existCode(codePage)) {
            fs.writeFileSync(jlinkCommandsFile.path, EncodingConverter.toTargetCode(jlinkCommandtemplate, codePage));
        } else {
            jlinkCommandsFile.Write(jlinkCommandtemplate);
        }

        // -AutoConnect 1 -Device <DevName> -If <Interface> -Speed <value> -CommandFile <file>
        const cmdList: string[] = [
            '-ExitOnError', '1',
            '-AutoConnect', '1',
            '-Device', option.cpuInfo.cpuName,
            '-If', JLinkProtocolType[option.proType],
            '-Speed', `${option.speed || 4000}`,
            '-CommandFile', jlinkCommandsFile.path
        ];

        if ([JLinkProtocolType.JTAG, JLinkProtocolType.cJTAG].includes(option.proType)) {
            cmdList.push('-JTAGConf', '-1,-1');
        }

        return {
            isOk: true,
            params: cmdList
        };
    }

    protected _launch(commandLines: string[]): void {
        const jlinkExePath = SettingManager.instance().getJlinkExePath();
        const option = this.getUploadOptions<JLinkOptions>();
        const commandLine = CmdLineHandler.getCommandLine(jlinkExePath, commandLines);
        this.executeShellCommand(this.toolType, `${commandLine} ${option.otherCmds || ''}`.trimEnd());
    }
}

/**
 * stcgal programer
*/
export interface StcgalFlashOption extends UploadOption {
    eepromImgPath: string;
    options: string;
    extraOptions: string;
}

class StcgalUploader extends HexUploader<string[]> {

    toolType: HexUploaderType = 'stcgal';

    static readonly optionKeyMap: { [key: string]: string } = {
        'device': '-P',
        'port': '-p',
        'baudrate': '-b',
        'oscFreq': '-t',
        'handshakeBaudrate': '-l',
        'option': '-o'
    };

    constructor(prj: AbstractProject) {
        super(prj);
    }

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string[]>> {

        if (eraseAll) {
            GlobalEvent.emit('msg', newMessage('Warning', `not support 'Erase Chip' for '${this.toolType}' flasher`));
            return { isOk: false };
        }

        const resManager = ResManager.GetInstance();

        let portList: string[];
        try {
            portList = resManager.enumSerialPort();
        } catch (error) {
            GlobalEvent.emit('error', error);
            return { isOk: false };
        }

        if (portList.length === 0) {
            vscode.window.showWarningMessage('Not found any serialport !');
            return { isOk: false };
        }

        let option: any = Object.create(null);

        const opFile = new File(this.project.ToAbsolutePath(this.getUploadOptions<StcgalFlashOption>().options));
        if (opFile.IsFile()) {
            try {
                option = JSON.parse(opFile.Read());
            } catch (error) {
                GlobalEvent.emit('msg', {
                    type: 'Warning',
                    contentType: 'string',
                    content: 'Invalid flash option file !'
                });
            }
        }

        // not found port OR invalid port
        if (!option['port'] || !portList.includes(option['port'])) {
            if (portList.length > 1) {
                const port = await vscode.window.showQuickPick(portList, {
                    placeHolder: 'select a serialport to connect',
                    canPickMany: false
                });
                if (!port) {
                    return { isOk: false };
                }
                option['port'] = port;
            } else {
                option['port'] = portList[0];
            }
        }

        const commands: string[] = [];

        for (const key in option) {

            if (typeof option[key] === 'number') {
                option[key] = (<number>option[key]).toString();
            }

            if (option[key] !== '') {
                if (key === 'option') {
                    if (typeof option[key] === 'object') {
                        const devOption = option[key];
                        for (const key in devOption) {
                            if (typeof devOption[key] === 'number') {
                                devOption[key] = (<number>devOption[key]).toString();
                            }
                            if (devOption[key] !== '') {
                                commands.push('-o ' + key + '=' + devOption[key]);
                            }
                        }
                    }
                } else if (StcgalUploader.optionKeyMap[key]) {
                    commands.push(StcgalUploader.optionKeyMap[key] + ' ' + option[key]);
                }
            }
        }

        return {
            isOk: true,
            params: commands
        };
    }

    protected _launch(commands: string[]): void {

        const option = this.getUploadOptions<StcgalFlashOption>();
        const programs = this.parseProgramFiles(option);

        if (programs.length == 0) {
            throw new Error(`no any program files !`);
        }

        commands.push('"' + programs[0].path + '"');

        const eepromFile = this.toAbsolute(option.eepromImgPath);
        if (eepromFile && eepromFile.IsFile()) {
            commands.push('"' + eepromFile.path + '"');
        }

        // run
        this.executeShellCommand(this.toolType, `stcgal ${option.extraOptions} ${commands.join(' ')}`);
    }
}

/**
 * STLink programer
*/
export type STLinkProtocolType = 'SWD' | 'JTAG';

export interface STLinkOptions extends UploadOption {

    proType: STLinkProtocolType;

    address: string;

    resetMode: string;

    runAfterProgram: boolean;

    speed: number;

    elFile: string; /* external loader file */

    optionBytes: string; /* option bytes file */

    otherCmds: string;
}

class STLinkUploader extends HexUploader<string[]> {

    toolType: HexUploaderType = 'STLink';

    DEF_BIN_ADDR = '0x08000000';

    constructor(prj: AbstractProject) {
        super(prj);
    }

    private genCommandForStlinkCli(exe: File, eraseAll?: boolean): string[] {

        const commands: string[] = [];
        const options = this.getUploadOptions<STLinkOptions>();
        const programs = this.parseProgramFiles(options);

        if (programs.length == 0) {
            throw new Error(`no any program files !`);
        }

        /* connection commands */
        commands.push(
            '-c', options.proType, `FREQ=${options.speed.toString()}`, 'UR'
        );

        /* reset mode */
        if (options.resetMode && options.resetMode != 'default') {
            const optMap: any = { 'SWrst': 'Srst', 'HWrst': 'Hrst' };
            commands.push(optMap[options.resetMode] || options.resetMode);
        }

        /* flash commands */
        if (!eraseAll) {

            commands.push(
                '-P', programs[0].path
            );

            if (/\.bin$/i.test(programs[0].path)) {
                commands.push(programs[0].addr || options.address || this.DEF_BIN_ADDR);
            }

            if (/\.stldr$/i.test(options.elFile)) {
                const elFolder = File.fromArray([NodePath.dirname(exe.path), 'ExternalLoader']);
                commands.push('-EL', options.elFile.replace('<stlink>', elFolder.path));
            }

            // option bytes commands
            const optionFile = new File(this.project.ToAbsolutePath(options.optionBytes));
            if (optionFile.IsFile()) {
                const conf = <any>ini.parse(optionFile.Read());
                const confList: string[] = [];
                for (const key in conf) { confList.push(`${key}=${conf[key]}`) }
                if (confList.length > 0) {
                    commands.push('-OB');
                    confList.forEach((val) => { commands.push(val) });
                    commands.push('-rOB');
                }
            }

            commands.push(
                '-V', 'after_programming'
            );
        }

        // eraseAll
        else {
            commands.push(
                '-ME'
            );
        }

        /* misc commands */
        commands.push(
            '-NoPrompt',
            '-TVolt'
        );

        if (options.runAfterProgram) {
            commands.push('-Run');
        }

        return commands;
    }

    private genCommandForCubeProgramer(exe: File, eraseAll?: boolean): string[] {

        const commands: string[] = [];
        const options = this.getUploadOptions<STLinkOptions>();
        const programs = this.parseProgramFiles(options);

        if (programs.length == 0) {
            throw new Error(`no any program files !`);
        }

        /* connect cmd */
        commands.push('-c', `port=${options.proType}`, `freq=${options.speed}`);

        /* reset mode */
        if (options.resetMode && options.resetMode != 'default') {
            commands.push(`reset=${options.resetMode}`);
        }

        // program
        if (!eraseAll) {

            /* external loader */
            if (/\.stldr$/i.test(options.elFile)) {
                const elFolder = File.fromArray([NodePath.dirname(exe.path), 'ExternalLoader']);
                commands.push('-el', options.elFile.replace('<stlink>', elFolder.path));
            }

            // option bytes commands
            const optionFile = new File(this.project.ToAbsolutePath(options.optionBytes));
            if (optionFile.IsFile()) {
                const conf = <any>ini.parse(optionFile.Read());
                const confList: string[] = [];
                for (const key in conf) { confList.push(`${key}=${conf[key]}`) }
                if (confList.length > 0) {
                    commands.push('-ob');
                    confList.forEach((val) => { commands.push(val) });
                    commands.push('-ob', 'displ');
                }
            }

            /* download program */
            commands.push('--download', programs[0].path);

            if (/\.bin$/i.test(programs[0].path)) {
                commands.push(programs[0].addr || options.address || this.DEF_BIN_ADDR);
            }

            /* verify program */
            commands.push('-v');
        }

        // erase all
        else {
            commands.push(
                '-e', 'all'
            );
        }

        if (options.runAfterProgram) { commands.push('--go') }

        return commands;
    }

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string[]>> {

        const exe = new File(SettingManager.GetInstance().getSTLinkExePath());
        if (!exe.IsFile()) {
            await ResInstaller.instance().setOrInstallTools(this.toolType, `Not found 'ST-LINK_CLI${exeSuffix()}' or 'STM32_Programmer_CLI${exeSuffix()}' !`);
            return { isOk: false };
        }

        let commands: string[];

        /* use stlink cli */
        if (exe.noSuffixName.toLowerCase().startsWith('st-link_cli')) {
            commands = this.genCommandForStlinkCli(exe, eraseAll);
        }

        /* use cube programer */
        else {
            commands = this.genCommandForCubeProgramer(exe, eraseAll);
        }

        return {
            isOk: true,
            params: commands
        };
    }

    protected _launch(commands: string[]): void {

        const exe = new File(SettingManager.GetInstance().getSTLinkExePath());
        const commandLine = CmdLineHandler.getCommandLine(exe.path, commands);
        const options = this.getUploadOptions<STLinkOptions>();

        // run
        let cmd = `${commandLine} ${options.otherCmds || ''}`.trimEnd();
        if (osType() == 'win32' && exe.noSuffixName.toLowerCase().startsWith('stm32_programmer_cli'))
            cmd = 'chcp 437 && ' + cmd; // chcp 437: 去除进度条乱码

        this.executeShellCommand(this.toolType, cmd,
            undefined, undefined, this.project.getRootDir().path);
    }
}

/**
 * STVP programer
*/
export interface STVPFlasherOptions extends UploadOption {

    deviceName: string;

    eepromFile: string;

    optionByteFile: string;
}

class STVPHexUploader extends HexUploader<string[]> {

    toolType: HexUploaderType = 'STVP';

    private isEraseMode?: boolean;

    constructor(prj: AbstractProject) {
        super(prj);
    }

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string[]>> {

        const exe = new File(SettingManager.GetInstance().getStvpExePath());
        if (!exe.IsFile()) {
            await ResInstaller.instance().setOrInstallTools(this.toolType, `Not found STVP: \'STVP_CmdLine${exeSuffix()}\' !`);
            return { isOk: false };
        }

        // set flag
        this.isEraseMode = eraseAll;

        if (eraseAll) {
            return {
                isOk: true,
                params: []
            };
        }

        const options = this.getUploadOptions<STVPFlasherOptions>();
        const programs = this.parseProgramFiles(options);

        const commands: string[] = [];

        // connection commands
        commands.push('-BoardName=ST-LINK');
        commands.push('-Port=USB');
        commands.push('-ProgMode=SWIM');
        commands.push('-Device=' + options.deviceName);

        // misc commands
        commands.push('-no_progress');
        commands.push('-no_loop');
        commands.push('-no_log');

        // program
        if (programs.length == 0) {
            throw new Error(`No valid program files !`);
        }

        let fileCount: number = 0;

        // program
        const binFile = this.toAbsolute(programs[0].path);
        if (binFile && binFile.IsFile()) {
            commands.push('-FileProg=\"' + binFile.path + '\"');
            fileCount++;
        }

        // eeprom
        const eepromFile = this.toAbsolute(options.eepromFile);
        if (eepromFile && eepromFile.IsFile()) {
            commands.push('-FileData=\"' + eepromFile.path + '\"');
            fileCount++;
        }

        // option bytes
        const opFile = this.toAbsolute(options.optionByteFile);
        if (opFile && opFile.IsFile()) {
            commands.push('-FileOption=\"' + opFile.path + '\"');
            fileCount++;
        }

        // verify prog
        if (fileCount > 0) {
            commands.push('-verif');
        } else { // no files need be programed
            throw new Error('No valid program files !');
        }

        return {
            isOk: true,
            params: commands
        };
    }

    protected _launch(commands: string[]): void {

        const eraseAll: boolean | undefined = this.isEraseMode;

        this.isEraseMode = undefined; // clear flag

        // normal flash mode
        if (!eraseAll) {
            const commandLine = CmdLineHandler.getCommandLine(
                SettingManager.GetInstance().getStvpExePath(), commands, false, true);
            this.executeShellCommand(this.toolType, commandLine);
        }

        // erase all mode
        else {
            const options = this.getUploadOptions<STVPFlasherOptions>();
            const datDir = ResManager.GetInstance().GetAppDataDir();
            const stvpDir = NodePath.dirname(SettingManager.GetInstance().getStvpExePath());
            const cli = `bash "./stm8_erase.sh"`;
            const envs = process.env;
            envs['EIDE_STM8_CPU'] = options.deviceName;
            envs['EIDE_DAT_ROOT'] = datDir.path;
            prependToSysEnv(envs, [stvpDir, ResManager.GetInstance().getStvpToolsDir().path]);
            this.executeShellCommand(this.toolType, cli, envs, undefined, datDir.path);
        }
    }
}

/**
 * pyOCD programer
*/
export interface PyOCDFlashOptions extends UploadOption {

    targetName: string;

    config?: string;

    speed?: string;

    baseAddr?: string;

    otherCmds: string;
}

class PyOCDUploader extends HexUploader<string[]> {

    toolType: HexUploaderType = 'pyOCD';

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string[]>> {

        const commandLines: string[] = [];

        const option = this.getUploadOptions<PyOCDFlashOptions>();
        const programs = this.parseProgramFiles(option);

        // program
        if (!eraseAll) {

            if (programs.length == 0) {
                throw new Error(`no any program files !`);
            }

            commandLines.push('flash');
        }

        // erase all
        else {
            commandLines.push('erase', '--chip');
        }

        if (option.config) {
            const confFile = new File(this.project.ToAbsolutePath(option.config));
            if (confFile.IsFile()) {
                commandLines.push('--config');
                commandLines.push(confFile.path);
            }
        }

        // target name
        commandLines.push('-t');
        commandLines.push(option.targetName);

        // speed
        if (option.speed) {
            commandLines.push('-f');
            commandLines.push(option.speed);
        }

        // file path
        if (!eraseAll) {
            programs.forEach((file) => {
                if (/\.bin$/i.test(file.path)) {
                    const baseAddr = programs[0].addr || option.baseAddr || this.DEF_BIN_ADDR;
                    commandLines.push(`${file.path}@${baseAddr}`);
                } else {
                    commandLines.push(file.path);
                }
            });
        }

        return {
            isOk: true,
            params: commandLines
        };
    }

    protected _launch(commands: string[]): void {

        let commandLine: string = 'pyocd ' +
            commands.map((line) => CmdLineHandler.quoteString(line, '"')).join(' ');

        // add user cmds
        const options = this.getUploadOptions<STLinkOptions>();
        if (options.otherCmds) {
            commandLine = commandLine.replace(/^pyocd\s+(\w+)/, `pyocd $1 ` + options.otherCmds);
        }

        // run
        this.executeShellCommand(this.toolType, commandLine);
    }
}

/**
 * OpenOCD flasher
*/
export interface OpenOCDFlashOptions extends UploadOption {

    target: string;

    interface: string;

    baseAddr?: string;
}

class OpenOCDUploader extends HexUploader<string[]> {

    toolType: HexUploaderType = 'OpenOCD';

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string[]>> {

        if (eraseAll) {
            GlobalEvent.emit('msg', newMessage('Warning', `not support 'Erase Chip' for '${this.toolType}' flasher`));
            return { isOk: false };
        }

        const exe = new File(SettingManager.GetInstance().getOpenOCDExePath());
        if (!exe.IsFile()) {
            await ResInstaller.instance().setOrInstallTools(this.toolType, `Not found \'OpenOCD${exeSuffix()}\' !`);
            return { isOk: false };
        }

        const option = this.getUploadOptions<OpenOCDFlashOptions>();
        const programs = this.parseProgramFiles(option);

        if (programs.length == 0) {
            throw new Error(`no any program files !`);
        }

        const commands: string[] = [];

        const wsFolder = WorkspaceManager.getInstance().getWorkspaceRoot();
        if (wsFolder) {
            commands.push(
                `-s "${wsFolder.path}"`
            );
        }

        const addConfig = (typ: 'interface' | 'target', fname: string) => {
            if (fname.trim() != '') {
                let fpath: string = fname.startsWith('${workspaceFolder}/')
                    ? fname.replace('${workspaceFolder}/', '')
                    : `${typ}/${fname}`;
                let cfg = `-f ${fpath}.cfg`;
                if (!commands.includes(cfg))
                    commands.push(cfg);
            }
        };

        addConfig('interface', option.interface);
        addConfig('target', option.target);

        programs.forEach(file => {
            if (/\.bin$/i.test(file.path)) {
                const addrStr = file.addr || option.baseAddr || this.DEF_BIN_ADDR;
                commands.push(`-c "program \\"${File.ToUnixPath(file.path)}\\" ${addrStr} verify"`);
            } else {
                commands.push(`-c "program \\"${File.ToUnixPath(file.path)}\\" verify"`);
            }
        });

        commands.push(`-c "reset run"`);
        commands.push(`-c "exit"`);

        return {
            isOk: true,
            params: commands
        };
    }

    protected _launch(commands: string[]): void {
        const exePath = SettingManager.GetInstance().getOpenOCDExePath();
        const commandLine = `${CmdLineHandler.quoteString(exePath, '"')} ${commands.join(' ')}`;
        this.executeShellCommand(this.toolType, commandLine);
    }
}

export interface ProbeRSFlashOptions extends UploadOption {

    /*
    --chip <CHIP>
          [env: PROBE_RS_CHIP=]
    */
    target: string;

    /*
    --protocol <PROTOCOL>
          Protocol used to connect to chip. Possible options: [swd, jtag]
    */
    protocol: string;

    /*
    --speed <SPEED>
          The protocol speed in kHz
    */
    speed: number;

    /*
    --base-address <BASE_ADDRESS>
          The address in memory where the binary will be put at. This is only considered when `bin` is selected as the format
    */
    baseAddr: string;

    /*
    --allow-erase-all
          Use this flag to allow all memory, including security keys and 3rd party firmware, to be erased even when it has read-only protection
    */
    allowEraseAll: boolean;

    /*
    other user options pass to cli
    */
    otherOptions: string;
}

class ProbeRSUploader extends HexUploader<string[]> {

    toolType: HexUploaderType = 'probe-rs';

    private _getEnv(): any {
        const env = deepCloneObject(process.env);
        prependToSysEnv(env, [
            NodePath.join(`${userhome()}`, '.cargo', 'bin') // $HOME/.cargo/bin/
        ]);
        return env;
    }

    protected parseProgramFiles<T extends UploadOption>(options: T): FlashProgramFile[] {

        const result: FlashProgramFile[] = [];
        const matcher = /(?<path>[^,]+)(?:,(?<addr>0x[a-f0-9]+))?/i;

        // if 'bin' path is empty, use default program path 
        if (options.bin.trim() === '') {
            const elfPath = ['.', this.project.getOutputDir(), this.project.getProjectName() + '.elf'].join(File.sep);
            return [
                { path: elfPath }
            ];
        }

        options.bin.split(';').forEach((path) => {
            const m = matcher.exec(path);
            if (m && m.groups && m.groups['path']) {
                result.push({
                    path: this.project.resolveEnvVar(m.groups['path']),
                    addr: m.groups['addr']
                });
            }
        });

        return result;
    }

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string[]>> {

        try {
            // PS C:\Users\Administrator> cargo-flash --version
            // cargo flash 0.29.1 (git commit: 1cf182e)
            child_process.execSync(`cargo-flash --version`, { env: this._getEnv() });
        } catch (error) {
            GlobalEvent.log_warn(error);
            vscode.window.showWarningMessage(
                `Not found 'cargo-flash' command. Install it now ?`, 'Yes', 'No').then(opt => {
                    if (opt === 'Yes')
                        probers_install();
                });
            return { isOk: false };
        }

        if (eraseAll) {
            GlobalEvent.emit('msg', newMessage('Warning', `not support 'Erase Chip' for '${this.toolType}' flasher`));
            return { isOk: false };
        }

        const option = this.getUploadOptions<ProbeRSFlashOptions>();
        const programs = this.parseProgramFiles(option);

        if (programs.length == 0) {
            throw new Error(`no any program files !`);
        }

        const commands: string[] = [
            `--chip ${option.target}`,
            `--protocol ${option.protocol}`
        ];

        const wsFolder = WorkspaceManager.getInstance().getWorkspaceRoot();
        if (wsFolder) {
            commands.push(
                `--work-dir "${wsFolder.path}"`
            );
        }

        // just support one file
        commands.push(`--path "${programs[0].path}"`);
        // if (programs[0].path.endsWith('.bin')) {
        //     if (programs[0].addr || option.baseAddr) {
        //         const baseAddr = programs[0].addr || option.baseAddr;
        //         commands.push(`--base-address ${baseAddr}`);
        //     }
        // }
        commands.push(`--verify`);

        if (option.speed)
            commands.push(`--speed ${option.speed}`);
        // if (option.allowEraseAll)
        //     commands.push(`--allow-erase-all`);

        // place otherOptions at the last, maybe user want to override some options.
        if (option.otherOptions)
            commands.push(option.otherOptions);

        return {
            isOk: true,
            params: commands
        };
    }

    protected _launch(commands: string[]): void {
        const commandLine = `cargo-flash ${commands.join(' ')}`;
        this.executeShellCommand(this.toolType, commandLine, this._getEnv());
    }
}

/**
 * Custom flasher
*/
export interface CustomFlashOptions extends UploadOption {
    commandLine: string;
    eraseChipCommand: string;
}

class CustomUploader extends HexUploader<string> {

    toolType: HexUploaderType = 'Custom';

    protected async _prepare(eraseAll?: boolean): Promise<UploaderPreData<string>> {

        const option = this.getUploadOptions<CustomFlashOptions>();
        const programs = this.parseProgramFiles(option);

        if (programs.length == 0) {
            return {
                isOk: new Error(`no any program files !`)
            };
        }

        if (eraseAll) {
            option.commandLine = option.eraseChipCommand;
        }

        if (option.commandLine === undefined) {
            return {
                isOk: new Error('flash command can not be empty !')
            };
        }

        // if use `bash` in win32, convert to unix dir sep
        if (osType() == 'win32' && /(^bash\b|\bbash\.exe)/i.test(option.commandLine.trim())) {
            for (const prog of programs) {
                prog.path = File.ToUnixPath(prog.path);
            }
        }

        let commandLine = this.resolveHexFilePathEnvs(option.commandLine, programs);

        // replace env
        commandLine = this.project.replacePathEnv(commandLine);

        return {
            isOk: true,
            params: commandLine
        };
    }

    protected _launch(commandLine: string): void {

        let env = process.env;

        // set env
        const prjEnv = this.project.getProjectVariables();
        if (prjEnv) {
            for (const key in prjEnv) {
                if (key.toUpperCase() == 'PATH') {
                    const pList: string[] = prjEnv[key]
                        .split(/:|;/)
                        .filter((p: string) => p.trim() !== '')
                        .map((p: string) => this.project.ToAbsolutePath(p));
                    if (pList.length > 0) {
                        env = concatSystemEnvPath(pList, env);
                    }
                } else {
                    env[key] = prjEnv[key]
                }
            }
        }

        this.executeShellCommand(this.toolType, commandLine, env);
    }
}
