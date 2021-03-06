// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fsx from 'fs-extra';
import * as path from 'path';
import * as ts from 'typescript';
import lodash = require('lodash');
import colors = require('colors');

import { JsonFile, JsonSchema } from '@microsoft/node-core-library';
import {
  IExtractorConfig,
  IExtractorProjectConfig,
  IExtractorApiJsonFileConfig
} from './IExtractorConfig';
import { ExtractorContext } from '../ExtractorContext';
import { ILogger } from './ILogger';
import ApiJsonGenerator from '../generators/ApiJsonGenerator';
import ApiFileGenerator from '../generators/ApiFileGenerator';
import { MonitoredLogger } from './MonitoredLogger';

/**
 * Options for {@link Extractor.processProject}.
 * @public
 */
export interface IAnalyzeProjectOptions {
  /**
   * If omitted, then the {@link IExtractorConfig.project} config will be used by default.
   */
  projectConfig?: IExtractorProjectConfig;
}

/**
 * Runtime options for Extractor.
 *
 * @public
 */
export interface IExtractorOptions {
  /**
   * If IExtractorConfig.project.configType = 'runtime', then the TypeScript compiler state
   * must be provided via this option.
   */
  compilerProgram?: ts.Program;

  /**
   * Allows the caller to handle API Extractor errors; otherwise, they will be logged
   * to the console.
   */
  customLogger?: Partial<ILogger>;

  /**
   * Indicates that API Extractor is running as part of a local build, e.g. on developer's
   * machine. This disables certain validation that would normally be performed
   * for a ship/production build. For example, the *.api.ts review file is
   * automatically local in a debug build.
   *
   * The default value is false.
   */
  localBuild?: boolean;
}

/**
 * Used to invoke the API Extractor tool.
 * @public
 */
export class Extractor {
  /**
   * The JSON Schema for API Extractor config file (api-extractor-config.schema.json).
   */
  public static jsonSchema: JsonSchema = JsonSchema.fromFile(
    path.join(__dirname, './api-extractor.schema.json'));

  private static _defaultConfig: Partial<IExtractorConfig> = JsonFile.load(path.join(__dirname,
    './api-extractor-defaults.json'));

  private static _defaultLogger: ILogger = {
    logVerbose: (message: string) => console.log('(Verbose) ' + message),
    logInfo: (message: string) => console.log(message),
    logWarning: (message: string) => console.warn(colors.yellow(message)),
    logError: (message: string) => console.error(colors.red(message))
  };

  private readonly _config: IExtractorConfig;
  private readonly _program: ts.Program;
  private readonly _localBuild: boolean;
  private readonly _monitoredLogger: MonitoredLogger;
  private readonly _absoluteRootFolder: string;

  private static _applyConfigDefaults(config: IExtractorConfig): IExtractorConfig {
    // Use the provided config to override the defaults
    const normalized: IExtractorConfig  = lodash.merge(
      lodash.cloneDeep(Extractor._defaultConfig), config);

    return normalized;
  }

  public constructor(config: IExtractorConfig, options?: IExtractorOptions) {
    let mergedLogger: ILogger;
    if (options && options.customLogger) {
      mergedLogger = lodash.merge(lodash.clone(Extractor._defaultLogger), options.customLogger);
    } else {
      mergedLogger = Extractor._defaultLogger;
    }
    this._monitoredLogger = new MonitoredLogger(mergedLogger);

    this._config = Extractor._applyConfigDefaults(config);

    this._monitoredLogger.logVerbose('API Extractor Config: ' + JSON.stringify(this._config));

    if (!options) {
      options = { };
    }

    this._localBuild = options.localBuild || false;

    switch (this._config.compiler.configType) {
      case 'tsconfig':
        const rootFolder: string = this._config.compiler.rootFolder;
        if (!fsx.existsSync(rootFolder)) {
          throw new Error('The root folder does not exist: ' + rootFolder);
        }

        this._absoluteRootFolder = path.normalize(path.resolve(rootFolder));

        let tsconfig: {} | undefined = this._config.compiler.overrideTsconfig;
        if (!tsconfig) {
          // If it wasn't overridden, then load it from disk
          tsconfig = JsonFile.load(path.join(this._absoluteRootFolder, 'tsconfig.json'));
        }

        const commandLine: ts.ParsedCommandLine = ts.parseJsonConfigFileContent(tsconfig,
          ts.sys, this._absoluteRootFolder);
        this._program = ts.createProgram(commandLine.fileNames, commandLine.options);

        if (commandLine.errors.length > 0) {
          throw new Error('Error parsing tsconfig.json content: ' + commandLine.errors[0].messageText);
        }

        break;

      case 'runtime':
        if (!options.compilerProgram) {
          throw new Error('The compiler.configType=runtime configuration was specified,'
            + ' but the caller did not provide an options.compilerProgram object');
        }

        this._program = options.compilerProgram;
        const rootDir: string | undefined = this._program.getCompilerOptions().rootDir;
        if (!rootDir) {
          throw new Error('The provided compiler state does not specify a root folder');
        }
        if (!fsx.existsSync(rootDir)) {
          throw new Error('The rootDir does not exist: ' + rootDir);
        }
        this._absoluteRootFolder = path.resolve(rootDir);
        break;

      default:
        throw new Error('Unsupported config type');
    }
  }

  /**
   * Invokes the API Extractor engine, using the configuration that was passed to the constructor.
   * @deprecated Use {@link Extractor.processProject} instead.
   */
  public analyzeProject(options?: IAnalyzeProjectOptions): void {
    this.processProject(options);
  }

  /**
   * Invokes the API Extractor engine, using the configuration that was passed to the constructor.
   * @param options - provides additional runtime state that is NOT part of the API Extractor
   *     config file.
   * @returns true if there were no errors or warnings; false if the tool chain should fail the build
   */
  public processProject(options?: IAnalyzeProjectOptions): boolean {
    this._monitoredLogger.resetCounters();

    if (!options) {
      options = { };
    }

    const projectConfig: IExtractorProjectConfig = options.projectConfig ?
      options.projectConfig : this._config.project;

    // This helps strict-null-checks to understand that _applyConfigDefaults() eliminated
    // any undefined members
    if (!(this._config.policies && this._config.apiJsonFile && this._config.apiReviewFile)) {
      throw new Error('The configuration object wasn\'t normalized properly');
    }

    const context: ExtractorContext = new ExtractorContext({
      program: this._program,
      entryPointFile: path.resolve(this._absoluteRootFolder, projectConfig.entryPointSourceFile),
      logger: this._monitoredLogger,
      policies: this._config.policies
    });

    for (const externalJsonFileFolder of projectConfig.externalJsonFileFolders || []) {
      context.loadExternalPackages(path.resolve(this._absoluteRootFolder, externalJsonFileFolder));
    }

    const packageBaseName: string = path.basename(context.packageName);

    const apiJsonFileConfig: IExtractorApiJsonFileConfig = this._config.apiJsonFile;

    if (apiJsonFileConfig.enabled) {
      const outputFolder: string = path.resolve(this._absoluteRootFolder,
        apiJsonFileConfig.outputFolder);

      fsx.mkdirsSync(outputFolder);

      const jsonGenerator: ApiJsonGenerator = new ApiJsonGenerator();
      const apiJsonFilename: string = path.join(outputFolder, packageBaseName + '.api.json');

      this._monitoredLogger.logVerbose('Writing: ' + apiJsonFilename);
      jsonGenerator.writeJsonFile(apiJsonFilename, context);
    }

    if (this._config.apiReviewFile.enabled) {
      const generator: ApiFileGenerator = new ApiFileGenerator();
      const apiReviewFilename: string = packageBaseName + '.api.ts';

      const actualApiReviewPath: string = path.resolve(this._absoluteRootFolder,
        this._config.apiReviewFile.tempFolder, apiReviewFilename);
      const actualApiReviewShortPath: string = this._getShortFilePath(actualApiReviewPath);

      const expectedApiReviewPath: string = path.resolve(this._absoluteRootFolder,
        this._config.apiReviewFile.apiReviewFolder, apiReviewFilename);
      const expectedApiReviewShortPath: string = this._getShortFilePath(expectedApiReviewPath);

      const actualApiReviewContent: string = generator.generateApiFileContent(context);

      // Write the actual file
      fsx.mkdirsSync(path.dirname(actualApiReviewPath));
      fsx.writeFileSync(actualApiReviewPath, actualApiReviewContent);

      // Compare it against the expected file
      if (fsx.existsSync(expectedApiReviewPath)) {
        const expectedApiReviewContent: string = fsx.readFileSync(expectedApiReviewPath).toString();

        if (!ApiFileGenerator.areEquivalentApiFileContents(actualApiReviewContent, expectedApiReviewContent)) {
          if (!this._localBuild) {
            // For production, issue a warning that will break the CI build.
            this._monitoredLogger.logWarning('You have changed the public API signature for this project.'
              // @microsoft/gulp-core-build seems to run JSON.stringify() on the error messages for some reason,
              // so try to avoid escaped characters:
              + ` Please overwrite ${expectedApiReviewShortPath} with a`
              + ` copy of ${actualApiReviewShortPath}`
              + ' and then request an API review. See the Git repository README.md for more info.');
          } else {
            // For a local build, just copy the file automatically.
            this._monitoredLogger.logWarning('You have changed the public API signature for this project.'
              + ` Updating ${expectedApiReviewShortPath}`);

            fsx.writeFileSync(expectedApiReviewPath, actualApiReviewContent);
          }
        } else {
          this._monitoredLogger.logVerbose(`The API signature is up to date: ${actualApiReviewShortPath}`);
        }
      } else {
        // NOTE: This warning seems like a nuisance, but it has caught genuine mistakes.
        // For example, when projects were moved into category folders, the relative path for
        // the API review files ended up in the wrong place.
        this._monitoredLogger.logError(`The API review file has not been set up.`
          + ` Do this by copying ${actualApiReviewShortPath}`
          + ` to ${expectedApiReviewShortPath} and committing it.`);
      }
    }

    // If there were any errors or warnings, then fail the build
    return (this._monitoredLogger.errorCount + this._monitoredLogger.warningCount) === 0;
  }

  private _getShortFilePath(absolutePath: string): string {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('Expected absolute path: ' + absolutePath);
    }
    return path.relative(this._absoluteRootFolder, absolutePath).replace(/\\/g, '/');
  }

}
