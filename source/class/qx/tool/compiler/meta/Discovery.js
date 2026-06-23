const path = require("upath");
const fs = require("fs");
const chokidar = require("chokidar");

/**
 * Discovery is used to discover files containing classes in a project by watching specified paths for changes.
 */
qx.Class.define("qx.tool.compiler.meta.Discovery", {
  extend: qx.core.Object,

  construct() {
    super();
    this.__discoveredFiles = {};
    this.__watchedPaths = {};
  },

  events: {
    /** Fired when a class is added to the discovery, data is {ClassMeta} */
    fileAdded: "qx.event.type.Data",

    /** Fired when a class is added to the discovery, data is {ClassMeta} */
    fileRemoved: "qx.event.type.Data",

    /** Fired when a class file changes, data is {ClassMeta} */
    fileChanged: "qx.event.type.Data",

    /** Fired when the discovery process is starting */
    starting: "qx.event.type.Event",

    /** Fired when the discover process has completed it initial scan and is watching for changes */
    started: "qx.event.type.Event"
  },

  properties: {
    watch: {
      init: false,
      check: "Boolean"
    }
  },

  members: {
    __started: false,

    /**
     * @typedef {Object} FileMeta
     * @property {String} classname - The name of the class
     *
     * @type {Object<String, FileMeta>} list of discovered files
     */
    __discoveredFiles: null,

    /**
     * @typedef WatchedPath
     * @property {String} path - The path to watch
     * @property {chokidar.FSWatcher} watcher - The chokidar watcher instance
     *
     * @type {Object<String, WatchedPath?>} list of WatchedPath objects.
     * The object values are initially null, but after the discovery starts they are changed for WatchedPath objects.
     */
    __watchedPaths: null,

    /**
     * Adds a path to the discovery process. The path can be a directory or a file.
     *
     * @param {String} filename
     */
    addPath(filename) {
      if (qx.core.Environment.get("qx.debug")) {
        if (this.__started) {
          throw new Error("Cannot add paths after discovery has started.");
        }
      }
      this.__watchedPaths[filename] = null;
    },

    /**
     * Starts the discovery process by watching the specified paths for changes
     */
    async start() {
      if (this.__started) {
        throw new Error("Discovery has already been started.");
      }
      this.fireEvent("starting");
      this.__started = true;
      if (this.getWatch()) {
        for (let filename in this.__watchedPaths) {
          filename = path.resolve(filename);
          let stat = await qx.tool.utils.files.Utils.safeStat(filename);
          if (!stat) {
            this.warn(`Directory ${filename} does not exist.`);
            continue;
          }
          let watcher = chokidar.watch(filename, {
            //ignored: /(^|[\/\\])\../
          });
          let watchedPath = {
            path: filename,
            watcher: watcher,
            ready: false
          };
          this.__watchedPaths[filename] = watchedPath;

          let confirmedName = filename;
          watcher.on("change", filename => this.__onFileChange("change", filename, confirmedName));
          watcher.on("add", filename => this.__onFileChange("add", filename, confirmedName));
          watcher.on("unlink", filename => this.__onFileChange("unlink", filename, confirmedName));
          watcher.on("ready", () => {
            qx.tool.compiler.Console.logVerbose(`Start watching ${confirmedName}...`);
            watchedPath.ready = true;
          });
          watcher.on("error", err => {
            qx.tool.compiler.Console.print(err.code == "ENOSPC" ? "qx.tool.cli.watch.enospcError" : "qx.tool.cli.watch.watchError", err);
          });
        }
      }

      // Scans a directory recursively to find all .js files
      const scanImpl = async (directoryName, rootDir) => {
        let packageName = path.relative(rootDir, directoryName);
        packageName = packageName.split(path.sep);
        packageName = packageName.join(".");

        let filenames = await fs.promises.readdir(directoryName);
        for (let i = 0; i < filenames.length; i++) {
          let filename = filenames[i];
          if (filename.match(/__init__/i)) {
            continue;
          }
          let fullFilename = path.join(directoryName, filename);
          let stat = await fs.promises.stat(fullFilename);
          if (stat.isDirectory()) {
            if (filename[0] != ".") {
              await scanImpl(fullFilename, rootDir);
            }
          } else if (stat.isFile()) {
            if (filename.endsWith(".js")) {
              let classname = path.basename(filename, ".js");
              if (packageName.length) {
                classname = packageName + "." + classname;
              }
              this.__discoveredFiles[fullFilename] = {
                classname
              };
            }
          }
        }
      };

      for (let filename in this.__watchedPaths) {
        await scanImpl(filename, filename);
      }
      let allClassnames = {};
      for (let filename in this.__discoveredFiles) {
        let classname = this.__discoveredFiles[filename].classname;
        if (allClassnames[classname]) {
          qx.tool.compiler.Console.print("qx.tool.compiler.discovery.duplicateClassname", classname, filename, allClassnames[classname]);
        }
        allClassnames[classname] = filename;
      }
      this.fireEvent("started");
    },

    async stop() {
      let watchedPaths = Object.values(this.__watchedPaths);
      this.__watchedPaths = {};
      for (let watchedPath of watchedPaths) {
        if (watchedPath?.watcher) {
          await watchedPath.watcher.close();
        }
      }
      this.fireEvent("stopped");
    },

    /**
     * Returns the list of discovered classes
     *
     * @returns {string[]} list of all discovered class files
     */
    getDiscoveredFiles() {
      return Object.keys(this.__discoveredFiles);
    },

    /**
     * @param {string} filename
     * @returns {string}
     */
    getClassnameForFile(filename) {
      if (qx.core.Environment.get("qx.debug")) {
        if (!this.__discoveredFiles[filename]) {
          throw new Error(`Cannot find file ${filename} in discovery.`);
        }
      }
      return this.__discoveredFiles[filename].classname;
    },

    /**
     * Called when a file change is detected
     *
     * @param {"added"|"unlink"|"change"} event
     * @param {String} filename filename of the changed file
     * @param {String} rootDir the directory where the file is located (used to determine the package name)
     */
    __onFileChange(event, filename, rootDir) {
      filename = path.normalize(filename);
      let packageName = path.relative(rootDir, filename);
      packageName = packageName.split(path.sep);
      packageName.pop();
      packageName = packageName.join(".");
      let classname = path.basename(filename, ".js");
      if (packageName.length) {
        classname = packageName + "." + classname;
      }
      if (event == "unlink") {
        if (this.__discoveredFiles[filename]) {
          this.fireDataEvent("fileRemoved", filename);
          delete this.__discoveredFiles[filename];
        }
      } else if (event == "add") {
        if (filename.endsWith(".js")) {
          this.__discoveredFiles[filename] = {
            classname
          };
          this.fireDataEvent("fileAdded", filename);
        }
      } else if (event == "change") {
        this.fireDataEvent("fileChanged", filename);
      }
    }
  }
});
