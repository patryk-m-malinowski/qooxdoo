/* ************************************************************************
 *
 *    qooxdoo-compiler - node.js based replacement for the Qooxdoo python
 *    toolchain
 *
 *    https://github.com/qooxdoo/qooxdoo
 *
 *    Copyright:
 *      2025 Zenesis Limited, http://www.zenesis.com
 *
 *    License:
 *      MIT: https://opensource.org/licenses/MIT
 *
 *      This software is provided under the same licensing terms as Qooxdoo,
 *      please see the LICENSE file in the Qooxdoo project's top-level directory
 *      for details.
 *
 *    Authors:
 *      * John Spackman (john.spackman@zenesis.com, @johnspackman)
 *      * Patryk Malinowski (pmalinowski@vmn.digital, @patryk-m-malinowski)
 *
 * *********************************************************************** */

const fs = qx.tool.utils.Promisify.fs;
const path = require("upath");

/**
 * Operates the Qooxdoo compiler, including discovery of classes, compilation of classes, and making of applications.
 *
 * @use(qx.core.BaseInit)
 * @use(qx.tool.*)
 * @use(qx.tool.compiler.ClassTranspilerApi)
 * @use(qx.tool.compiler.cli.api.CompilerApi)
 * @use(qx.tool.compiler.meta.ShadowMetaDatabaseApi)
 * @use(qx.tool.worker.WorkerServerApi)
 * @use(qx.tool.compiler.ClassTranspilerApi)
 */

qx.Class.define("qx.tool.compiler.Compiler", {
  implement: [qx.tool.compiler.ICompilerInterface],
  extend: qx.core.Object,

  construct() {
    super();
    this.__makers = [];
    this.__libraries = {};
    this.__discovery = new qx.tool.compiler.meta.Discovery();

    this.__dbClassInfoCache = {};
    this.__changedFiles = {};
    this.__compilingClasses = {};
    this.__dirtyClasses = {};
    this.__dirtyMakers = {};
    this.__makingMakers = {};
  },

  events: {
    /**
     * @override
     */
    writingApplications: "qx.event.type.Event",

    /**
     * @override
     */
    writingApplication: "qx.event.type.Data",

    /**
     * @override
     */
    writtenApplication: "qx.event.type.Data",

    /**
     * @override
     */

    writtenApplications: "qx.event.type.Data",

    /**
     * @override
     */
    compilingClass: "qx.event.type.Data",

    /**
     * @override
     */
    compiledClass: "qx.event.type.Data",

    /**
     * @override
     */
    saveDatabase: "qx.event.type.Data",

    /**
     * @override
     */
    checkEnvironment: "qx.event.type.Data",

    /**
     * @override
     */
    making: "qx.event.type.Data",

    /**
     * @override
     */
    made: "qx.event.type.Data",

    /**
     * @override
     */
    allDone: "qx.event.type.Event",

    /**
     * @override
     */
    minifyingApplication: "qx.event.type.Data",

    /**
     * @override
     */
    minifiedApplication: "qx.event.type.Data"
  },

  properties: {
    /** Root directory for the meta database */
    metaDir: {
      check: "String"
    },

    watch: {
      init: false,
      check: "Boolean"
    },

    maxWorkers: {
      check: "Integer"
    },

    typescriptEnabled: {
      init: false,
      check: "Boolean"
    },

    /** the name of the typescript file to generate, null = use default */
    typescriptFile: {
      init: null,
      nullable: true,
      check: "String"
    }
  },

  members: {
    /**
     * @type {qx.tool.compiler.targets.TypeScriptWriter|null}
     * The TypeScript writer instance, responsible for generating TypeScript definitions
     */
    __typescriptWriter: null,

    /**
     * @type {Object.<string, '+' | '-'>} List of changed files, indexed by file name,
     * with value "+" for added/changed files and "-" for removed files
     * These are for the classes that have been queued up for compilation but are not yet being compiled
     */
    __changedFiles: null,

    /** @type {qx.tool.worker.JobQueue} The queue of jobs to be run in qx.tool.worker.WorkerClient workers */
    __jobQueue: null,

    /** @type {qx.tool.compiler.meta.MetaDatabase} Meta database for all classes in this target */
    __metaDb: null,

    /** @type {Object<String, qx.tool.compiler.app.Library>} all libraries indexed by namespace */
    __libraries: null,

    /** @type {qx.tool.compiler.Maker[]} list of makers */
    __makers: null,

    /** @type {Object<string,qx.tool.compiler.ClassFile.DbClassInfo>} list of cached dbClassInfo, indexed by a hash key which is the target directory and classname, eg "source:mypkg.MyClass" */
    __dbClassInfoCache: null,

    /** @type {Object<String,Promise>} classes currently being compiled, index by hash of target directory and classname eg "source:mypkg.MyClass" */
    __compilingClasses: null,

    /** @type {Object<String,Boolean>} classes which are dirty and must be recompiled */
    __dirtyClasses: null,

    /** @type {Object<String,qx.tool.compiler.Maker>} list of makers which need to be 'made', indexed by hash code */
    __dirtyMakers: null,

    /** @type {Object<String,Promise>} list of makers currently making, indexed by hash code */
    __makingMakers: null,

    /**
     * Adds a maker to the discovery process, which will then
     * add all libraries that the maker uses to the discovery.
     */
    addMaker(maker) {
      this.__makers.push(maker);
      maker.getAnalyzer().setCompiler(this);
      for (let lib of maker.getAnalyzer().getLibraries()) {
        this.addLibrary(lib);
      }
      this.fireDataEvent("addMaker", maker);
    },

    /**
     * Adds a library to the discovery process.
     *
     * @param {qx.tool.compiler.app.Library} lib
     */
    addLibrary(lib) {
      if (this.__libraries[lib.getNamespace()]) {
        return;
      }

      let dir = path.join(lib.getRootDir(), lib.getSourcePath());
      try {
        let stat = fs.statSync(dir);
        if (stat.isDirectory()) {
          this.__discovery.addPath(dir);
          this.__libraries[lib.getNamespace()] = lib;
        }
      } catch (ex) {
        if (ex.code !== "ENOENT") {
          throw ex; // rethrow if it's not a "file not found" error
        }
      }
    },

    /**
     * @override
     */
    async start() {
      if (!this.__makers || !this.__makers.length) {
        throw new qx.tool.utils.Utils.UserError("Error: Cannot find anything to make");
      }

      let configDb = await qx.tool.compiler.cli.ConfigDb.getInstance();
      let compilerApi = qx.tool.compiler.cli.ConfigLoader.getInstance().getCompilerApi();

      let poolMaxSize = this.getMaxWorkers() ?? Math.round(require("os").cpus().length / 2);
      this.__jobQueue = new qx.tool.worker.JobQueue().set({
        maxConcurrentJobs: poolMaxSize
      });

      /*
       * Configure MetaDatabase and Discovery
       */
      this.__metaDb = new qx.tool.compiler.meta.MetaDatabase(this.__jobQueue).set({
        rootDir: this.getMetaDir()
      });

      let metaDb = this.__metaDb;

      this.fireEvent("starting");
      await metaDb.load();
      this.fireEvent("metaDbLoaded");
      this.__discovery.setWatch(this.getWatch());
      await this.__discovery.start();
      this.fireEvent("discoveryStarted");

      // Store the libraries in the meta database
      this.fireEvent("metaDbConfiguring");
      metaDb.getDatabase().libraries = {};
      let environmentChecks = {};
      for (let lib of Object.values(this.__libraries)) {
        let dir = path.join(lib.getRootDir(), lib.getSourcePath());
        metaDb.getDatabase().libraries[lib.getNamespace()] = {
          sourceDir: dir
        };
        let libChecks = lib.getEnvironmentChecks();
        for (let checkName in libChecks) {
          environmentChecks[checkName] = libChecks[checkName];
        }
      }
      metaDb.getDatabase().environmentChecks = environmentChecks;
      this.fireEvent("metaDbConfigured");

      /*
       * Configure the worker pool
       */
      this.__jobQueue.addListener("workerClientReady", async evt => {
        let workerClient = evt.getData();
        let shadowMetaApi = await workerClient.getApi(qx.tool.compiler.meta.IShadowMetaDatabaseApi);
        await shadowMetaApi.setEnvironmentChecks(this.__metaDb.getEnvironmentChecks());
        this.__metaDb.addListener("classMetaParsed", async evt => {
          let classMeta = evt.getData();
          await shadowMetaApi.updateClassMeta(classMeta.getSharedBufferMetaData());
        });
        for (let classname of this.__metaDb.getClassnames()) {
          let classMeta = this.__metaDb.getClassMeta(classname);
          await shadowMetaApi.updateClassMeta(classMeta.getSharedBufferMetaData());
        }
      });
      await this.__jobQueue.start();

      this.__startError ||= !(await metaDb.addFiles(this.__discovery.getDiscoveredFiles()));
      this.fireEvent("addedDiscoveredClasses");

      if (this.getTypescriptEnabled()) {
        this.__typescriptWriter = new qx.tool.compiler.targets.TypeScriptWriter(this.__metaDb);
        this.__typescriptWriter.setOutputTo(this.getTypescriptFile() ?? path.join(this.getMetaDir(), "..", "qooxdoo.d.ts"));
      }

      /**
       * Updates the meta database and compiles the classes that have been queued up
       */
      let debounceProcessChangedFiles = new qx.util.Debounce(() => this.__processChangedFiles(), 100);

      if (this.getWatch()) {
        /**
         * Adds a class to the compilation queue
         * @param {qx.event.type.Data} evt
         */
        const onFileChange = async evt => {
          let filename = evt.getData();
          this.__changedFiles[filename] = "+";
          debounceProcessChangedFiles.trigger();
        };
        this.__discovery.addListener("fileAdded", onFileChange);
        this.__discovery.addListener("fileChanged", onFileChange);
        this.__discovery.addListener("fileRemoved", async evt => {
          let filename = evt.getData();
          this.__changedFiles[filename] = "-";
          debounceProcessChangedFiles.trigger();
        });
      }

      // Process the meta data and save to disk
      await metaDb.save();
      await this.fireDataEventAsync("writtenMetaData", metaDb);

      if (this.getTypescriptEnabled()) {
        qx.tool.compiler.Console.info(`Generating typescript output ...`);
        await this.__typescriptWriter.process();
      }

      new qx.tool.compiler.feedback.ConsoleFeedback(this);

      for (let maker of this.__makers) {
        var analyzer = maker.getAnalyzer();
        let cfg = await qx.tool.compiler.cli.ConfigDb.getInstance();
        analyzer.setWritePoLineNumbers(cfg.db("qx.translation.strictPoCompatibility", false));

        let stat = await qx.tool.utils.files.Utils.safeStat("source/index.html");

        if (stat) {
          qx.tool.compiler.Console.print("qx.tool.cli.compile.legacyFiles", "source/index.html");
        }

        var target = maker.getTarget();
        analyzer.addListener("compilingClass", e => this.dispatchEvent(e.clone()));
        analyzer.addListener("compiledClass", e => this.dispatchEvent(e.clone()));
        analyzer.addListener("saveDatabase", e => this.dispatchEvent(e.clone()));
        target.addListener("checkEnvironment", e => this.dispatchEvent(e.clone()));

        maker.addListener("writingApplications", e => this.dispatchEvent(e.clone()));
        maker.addListener("writingApplication", e => this.dispatchEvent(e.clone()));
        maker.addListener("writtenApplication", e => this.dispatchEvent(e.clone()));
        maker.addListener("writtenApplications", e => this.dispatchEvent(e.clone()));

        if (target instanceof qx.tool.compiler.targets.BuildTarget) {
          target.addListener("minifyingApplication", e => this.dispatchEvent(e.clone()));
          target.addListener("minifiedApplication", e => this.dispatchEvent(e.clone()));
        }

        maker.addListener("making", async () => {
          await this.fireDataEventAsync("making", maker);
        });

        maker.addListener("made", async () => {
          await this.fireDataEventAsync("made", maker);
        });
      }

      try {
        let promises = this.__makers.map(maker => maker.make());
        await Promise.all(promises);
        console.log("All makers made");
      } catch (ex) {
        console.error("Error during compilation: " + ex.stack);
        throw ex;
      }
    },

    /**
     * Regenerates the meta database with the file changes, generates the TypeScript file if TypeScript is enabled,
     * and triggers recompilation
     */
    async __processChangedFiles() {
      let metaDb = this.__metaDb;
      this.fireEvent("changesDetected");
      let changedFiles = this.__changedFiles;
      let added = [];
      this.__changedFiles = {};

      await Promise.all(
        Object.entries(changedFiles).map(async ([filename, changeType]) => {
          if (changeType === "+") {
            let classname = this.__discovery.getClassnameForFile(filename);
            added.push(classname);
            await metaDb.addFile(filename, true);
          } else {
            await metaDb.removeFile(filename);
          }
        })
      );

      await metaDb.reparseAll();
      await metaDb.save();

      if (this.getTypescriptEnabled()) {
        qx.tool.compiler.Console.logVerbose(`Generating typescript output ...`);
        await this.__typescriptWriter.process();
      }

      let compilationRequired = false;
      for (let maker of this.__makers) {
        for (let app of maker.getApplications()) {
          let dependencies = app.getDependencies() || [];
          for (let classname of added) {
            if (dependencies.includes(classname) || app.getRequiredClasses().includes(classname) || app.getTheme() == classname) {
              compilationRequired = true;
              let hashKey = maker.getAnalyzer().toHashCode() + ":" + classname;
              this.__dirtyClasses[hashKey] = true;
              this.compileClass(maker.getAnalyzer(), classname, true);
              this.fireDataEvent("classNeedsToBeCompiled", { maker, classname });
              break;
            }
          }
        }
      }

      if (!compilationRequired) {
        this.fireEvent("allMakersMade");
        await this.fireEventAsync("allDone");
      }
    },

    /**
     * Compiles a class for the given analyzer and classname.  If the class is already compiled,
     * it will return the cached information unless `force` is true.
     *
     * @param {qx.tool.compiler.Analyzer} analyzer
     * @param {String} classname
     * @param {Boolean} force
     * @returns {Promise<qx.tool.compiler.ClassFile.DbClassInfo>} the class information
     *
     */
    compileClass(analyzer, classname, force) {
      let hashKey = analyzer.toHashCode() + ":" + classname;
      let existingCompile = this.__compilingClasses[hashKey];
      if (this.__dirtyClasses[hashKey]) {
        if (existingCompile) {
          if (!existingCompile.job) {
            return existingCompile.promise;
          } else if (existingCompile.job.status === "running") {
            existingCompile.restart = true;
            return existingCompile.promise;
          } else {
            this.__jobQueue.removeJob(existingCompile.job);
            existingCompile = null;
            delete this.__compilingClasses[hashKey];
          }
        }
        delete this.__dirtyClasses[hashKey];
      }

      const onClassCompiledError = err => {
        delete this.__compilingClasses[hashKey];
        qx.tool.compiler.Console.error("Unhandled exception while compiling class " + classname + ": " + err.stack);
        existingCompile.promise.resolve({ fatalCompileError: true });
      };

      const onClassCompiled = result => {
        if (existingCompile.restart) {
          delete existingCompile.restart;
          compileClassImpl(analyzer, classname, force).then(onClassCompiled).catch(onClassCompiledError);
          return;
        }
        delete this.__compilingClasses[hashKey];
        this._onClassCompiled(analyzer, classname, result);
        existingCompile.promise.resolve(result.dbClassInfo);
      };

      const compileClassImpl = async () => {
        let meta = this.__metaDb.getMetaData(classname);
        if (!meta) {
          qx.tool.compiler.Console.error(`Compiler Error: Cannot find class ${classname} in project/libraries.`);
          return { dbClassInfo: { fatalCompileError: true } };
        }

        let sourceFilename = path.resolve(path.join(this.__metaDb.getRootDir(), meta.classFilename));
        let outputDir = analyzer.getMaker().getTarget().getOutputDir();
        let outputFilename = path.join(outputDir, "transpiled", classname.replace(/\./g, path.sep) + ".js");

        let jsonFilename = path.join(outputDir, "transpiled", classname.replace(/\./g, path.sep) + ".json");
        let hashKey = outputDir + ":" + classname;
        let dbClassInfo = this.__dbClassInfoCache[hashKey] || null;
        let sourceStat = await qx.tool.utils.files.Utils.safeStat(sourceFilename);

        if (!sourceStat) {
          throw new Error(`Source file for class ${classname} not found: ${sourceFilename}`);
        }

        if (!dbClassInfo) {
          if (fs.existsSync(jsonFilename)) {
            dbClassInfo = await qx.tool.utils.Json.loadJsonAsync(jsonFilename);
          }
        }

        if (!dbClassInfo) {
          dbClassInfo = {};
        }

        this.__dbClassInfoCache[hashKey] = dbClassInfo;

        if (!force) {
          let outputStat = await qx.tool.utils.files.Utils.safeStat(outputFilename);

          if (dbClassInfo && outputStat) {
            var dbMtime = null;
            try {
              dbMtime = dbClassInfo.mtime && new Date(dbClassInfo.mtime);
            } catch (e) {}
            if (dbMtime && dbMtime.getTime() == sourceStat.mtime.getTime()) {
              if (outputStat.mtime.getTime() >= sourceStat.mtime.getTime()) {
                return { dbClassInfo, cached: true };
              }
            }
          }
        }

        this.fireDataEvent("compilingClass", { classname, analyzer });

        let library = this.findLibraryForClassname(classname);
        Object.assign(dbClassInfo, {
          mtime: sourceStat.mtime,
          libraryName: library.getNamespace(),
          filename: sourceFilename
        });

        if (classname == "qx.tool.compiler.cli.commands.Clean") {
          debugger;
        }

        existingCompile.job = this.__jobQueue.addJob(qx.tool.compiler.IClassTranspilerApi, "transpileClass", {
          classname,
          sourceFilename: sourceFilename,
          outputFilename: outputFilename,
          manglePrefix: analyzer.getManglePrefix(classname),
          classFileConfig: analyzer.getClassFileConfig().serialize(),
          sourceTransformer: analyzer.getMaker().getTransformerClass()
        });
        let dbClassInfoNew = await existingCompile.job.promiseComplete;
        if (classname == "qx.tool.compiler.cli.commands.Clean") {
          debugger;
        }

        delete dbClassInfo.unresolved;
        delete dbClassInfo.dependsOn;
        delete dbClassInfo.assets;
        delete dbClassInfo.translations;
        delete dbClassInfo.markers;
        delete dbClassInfo.fatalCompileError;
        delete dbClassInfo.commonjsModules;

        for (var key in dbClassInfoNew) {
          dbClassInfo[key] = dbClassInfoNew[key];
        }

        await fs.promises.writeFile(jsonFilename, JSON.stringify(dbClassInfo, null, 2), "utf8");

        return { dbClassInfo, cached: false };
      };

      existingCompile = {
        promise: new qx.Promise(),
        job: null
      };
      this.__compilingClasses[hashKey] = existingCompile;
      compileClassImpl(analyzer, classname, force).then(onClassCompiled).catch(onClassCompiledError);

      return existingCompile.promise;
    },

    /**
     * Handler for when a class has been compiled.
     *
     * @param {qx.tool.compiler.Analyzer} analyzer
     * @param {String} classname
     * @param {CompilationResult} result Result of the compilation
     */
    _onClassCompiled(analyzer, classname, result) {
      if (!result.cached) {
        this.fireDataEvent("compiledClass", { classname, analyzer });
        let maker = analyzer.getMaker();
        maker.onClassCompiled(classname);
        for (let app of maker.getApplications()) {
          let dependencies = app.getDependencies() || [];
          if (dependencies.includes(classname) || app.getRequiredClasses().includes(classname) || app.getTheme() == classname) {
            this.__dirtyMakers[maker.toHashCode()] = maker;
            break;
          }
        }
      }

      //Only print the markers when we are making,
      //because all the classes get re-checked anyway when we make
      //and this will prevent duplicated markers being printed
      if (Object.keys(this.__makingMakers).length > 0) {
        let markers = result.dbClassInfo.markers;
        if (markers) {
          markers.forEach(function (marker) {
            var str = qx.tool.compiler.Console.decodeMarker(marker);
            qx.tool.compiler.Console.warn(classname + ": " + str + ` (${analyzer.getMaker().getTarget().getOutputDir()})`);
          });
        }
      }

      let makers = Object.values(this.__dirtyMakers);
      if (makers.length === 0 || Object.keys(this.__compilingClasses).length != 0) {
        return;
      }
      this.__dirtyMakers = {};
      for (let maker of makers) {
        this.__makeMaker(maker);
      }
    },

    __makeMaker(maker) {
      let hashKey = maker.toHashCode();
      if (this.__makingMakers[hashKey]) {
        return this.__makingMakers[hashKey];
      }

      let promise = maker.make();
      promise = promise
        .then(async () => {
          delete this.__makingMakers[hashKey];
          if (
            Object.keys(this.__makingMakers).length === 0 &&
            Object.keys(this.__dirtyMakers).length === 0 &&
            Object.keys(this.__compilingClasses).length === 0
          ) {
            this.fireEvent("allMakersMade");
            await this.fireEventAsync("allDone");
          }
          return true;
        })
        .catch(async err => {
          delete this.__makingMakers[hashKey];
          console.error("Error making maker " + maker.toHashCode() + ": " + err.stack);
          process.exit(1);
        });

      this.__makingMakers[hashKey] = promise;
      return promise;
    },

    /**
     * Find a library for a given classname
     *
     * @param {String} classname
     * @returns {qx.tool.compiler.app.Library?} the library for the given classname, or null if not found
     */
    findLibraryForClassname(classname) {
      let metaDb = this.getMetaDb();
      let classmeta = metaDb.getMetaData(classname);
      if (!classmeta) {
        return null;
      }
      let filename = classmeta.classFilename;
      filename = path.resolve(path.join(metaDb.getRootDir(), filename));
      for (let library of Object.values(this.__libraries)) {
        let libRootDir = path.resolve(library.getRootDir());
        if (filename.startsWith(libRootDir)) {
          return library;
        }
      }
      return null;
    },

    /**
     * @Override
     */
    async stop() {
      await this.__metaDb.save();
      if (this.__jobQueue) {
        await this.__jobQueue.stop();
      }
      await this.__discovery.stop();
    },

    /**
     * @override
     * @returns {qx.tool.compiler.Maker[]}
     */
    getMakers() {
      return this.__makers;
    },

    /**
     * Returns the meta database used by the compiler.
     *
     * @returns {qx.tool.compiler.meta.MetaDatabase}
     */
    getMetaDb() {
      return this.__metaDb;
    },

    /**
     * Returns the discovery used by the compiler.
     *
     * @returns {qx.tool.compiler.meta.Discovery}
     */
    getDiscovery() {
      return this.__discovery;
    }
  },

  defer(statics) {
    qx.tool.compiler.Console.addMessageIds({
      "qx.tool.compiler.cli.compile.minifyingApplication": "Minifying %1 %2",
      "qx.tool.compiler.cli.compile.compiledClass": "Compiled class %1 in %2s",
      "qx.tool.compiler.cli.compile.makeBegins": "Making applications...",
      "qx.tool.compiler.cli.compile.makeEnds": "Applications are made"
    });

    qx.tool.compiler.Console.addMessageIds(
      {
        "qx.tool.cli.compile.multipleDefaultTargets": "Multiple default targets found!",
        "qx.tool.cli.compile.unusedTarget": "Target type %1, index %2 is unused",
        "qx.tool.cli.compile.selectingDefaultApp":
          "You have multiple applications, none of which are marked as 'default'; the first application named %1 has been chosen as the default application",
        "qx.tool.cli.compile.legacyFiles": "File %1 exists but is no longer used",
        "qx.tool.cli.compile.deprecatedCompile": "The configuration setting %1 in compile.json is deprecated",
        "qx.tool.cli.compile.deprecatedCompileSeeOther": "The configuration setting %1 in compile.json is deprecated (see %2)",
        "qx.tool.cli.compile.deprecatedUri":
          "URIs are no longer set in compile.json, the configuration setting %1=%2 in compile.json is ignored (it's auto detected)",
        "qx.tool.compiler.cli.compile.deprecatedProvidesBoot":
          "Manifest.Json no longer supports provides.boot - only Applications can have boot; specified in %1",
        "qx.tool.cli.compile.deprecatedBabelOptions": "Deprecated use of `babelOptions` - these should be moved to `babel.options`",
        "qx.tool.cli.compile.deprecatedBabelOptionsConflicting":
          "Conflicting use of `babel.options` and the deprecated `babelOptions` (ignored)"
      },

      "warning"
    );
  }
});
