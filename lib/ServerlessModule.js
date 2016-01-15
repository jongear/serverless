'use strict';

/**
 * Serverless Module Class
 * - options.path format is: "moduleFolder"
 */

const SError         = require('./ServerlessError'),
  SUtils             = require('./utils/index'),
  BbPromise          = require('bluebird'),
  path               = require('path'),
  _                  = require('lodash'),
  fs                 = require('fs');

class ServerlessModule {

  /**
   * Constructor
   */

  constructor(Serverless, config) {

    // Validate required attributes
    if (!config.component || !config.module) throw new SError('Missing required config.component or config.module');

    let _this    = this;
    _this._S      = Serverless;
    _this._config = {};
    _this.updateConfig(config);

    // Default Properties
    _this.name           = _this._config.module || 'module' + SUtils.generateShortId(6);
    _this.version        = '0.0.1';
    _this.profile        = 'aws-v' + require('../package.json').version;
    _this.location       = 'https://github.com/...';
    _this.author         = '';
    _this.description    = 'A Serverless Module';
    _this.runtime        = 'nodejs';
    _this.custom         = {};
    _this.functions      = {};
    _this.cloudFormation = {
      resources: {},
      lambdaIamPolicyDocumentStatements: []
    };
  }

  /**
   * Update Config
   * - Takes config.component and config.module
   */

  updateConfig(config) {

    if (!config) return;

    // Set sPath
    if (config.component || config.module) {
      this._config.component = config.component;
      this._config.module    = config.module;
      this._config.sPath     = SUtils.buildSPath({
        component: config.component,
        module:    config.module
      });
    }
    // Make full path
    if (this._S.config.projectPath && this._config.sPath) {
      let parse            = SUtils.parseSPath(this._config.sPath);
      this._config.fullPath = path.join(this._S.config.projectPath, parse.component, parse.module);
    }
  }

  /**
   * Load
   * - Load from source (i.e., file system);
   * - Returns promise
   */

  load() {

    let _this = this,
      moduleJson,
      moduleContents;

    return BbPromise.try(function() {

        // Validate: Check project path is set
        if (!_this._S.config.projectPath) throw new SError('Module could not be loaded because no project path has been set on Serverless instance');

        // Validate: Check module exists
        if (!SUtils.fileExistsSync(path.join(_this._config.fullPath, 's-module.json'))) {
          throw new SError('Module could not be loaded because it does not exist in your project: ' + _this._config.sPath);
        }

        moduleJson           = SUtils.readAndParseJsonSync(path.join(_this._config.fullPath, 's-module.json'));
        moduleJson.functions = {};
        moduleContents       = fs.readdirSync(_this._config.fullPath);

        return moduleContents;
      })
      .each(function(f, i) {

        if (!SUtils.fileExistsSync(path.join(
            _this._config.fullPath, moduleContents[i],
            's-function.json'))) return;

        let func = new _this._S.classes.Function(_this._S, {
          component: _this._config.component,
          module:    _this._config.module,
          function:  f
        });
        return func.load()
          .then(function(instance) {
            moduleJson.functions[f] = instance;
            return moduleJson.functions[f];
          });
      })
      .then(function() {

        // Merge
        _.assign(_this, moduleJson);
        return _this;
      });
  }

  /**
   * Set
   * - Set data
   * - Accepts a data object
   */

  set(data) {
    let _this = this;

    // Instantiate Components
    for (let prop in data.functions) {

      if (data.functions[prop] instanceof _this._S.classes.Function) {
        throw new SError('You cannot pass subclasses into the set method, only object literals');
      }

      let instance = new _this._S.classes.Function(_this._S, {
        component: _this._config.component,
        module:    _this._config.module,
        function:  prop
      });
      data.functions[prop] = instance.set(data.functions[prop]);
    }

    // Merge in
    _this = _.extend(_this, data);
    return _this;
  }

  /**
   * Get
   * - Return data
   */

  get() {
    let clone  = _.cloneDeep(this);
    for (let prop in this.functions) {
      clone.functions[prop] = this.functions[prop].get();
    }
    return SUtils.exportClassData(clone);
  }

  /**
   * getPopulated
   * - Fill in templates then variables
   */

  getPopulated(options) {

    let _this = this;

    options = options || {};

    // Validate: Check Stage & Region
    if (!options.stage || !options.region) throw new SError('Both "stage" and "region" params are required');

    // Validate: Check project path is set
    if (!this._S.config.projectPath) throw new SError('Module could not be populated because no project path has been set on Serverless instance');

    // Populate module and its functions
    let clone = _.cloneDeep(this);
    if (clone.functions) clone.functions = {};

    return SUtils.populate(this._S, clone, options.stage, options.region)
      .then(function(data) {
        clone = data;
        clone.functions = {};
        for (let prop in _this.functions) {
          _this.functions[prop].getPopulated(options)
            .then(function(newData) {
              clone.functions[prop] = newData;
            });
        }
      })
      .then(function(){
        return clone
      });
  }

  /**
   * Get Templates
   * - Get templates in this module
   * - Returns promise
   */

  getTemplates() {

    let _this = this;

    return new BbPromise(function(resolve) {
      if (!SUtils.fileExistsSync(path.join(_this._config.fullPath, 's-templates.json'))) {
        return resolve({});
      } else {
        return resolve(SUtils.readAndParseJsonSync(path.join(_this._config.fullPath, 's-templates.json')));
      }
    });
  }

  /**
   * Save
   * - Saves data to file system
   * - Returns promise
   */

  save(options) {

    let _this = this;

    return new BbPromise.try(function() {

      // Validate: Check project path is set
      if (!_this._S.config.projectPath) throw new SError('Module could not be saved because no project path has been set on Serverless instance');

      // Create if does not exist
      if (!SUtils.fileExistsSync(path.join(_this._config.fullPath, 's-module.json'))) {
        return _this._create();
      }
    })
      .then(function() {

        // Save all nested functions
        if (options && options.deep) {
          return BbPromise.try(function () {
              return Object.keys(_this.functions);
            })
            .each(function(f) {
              return _this.functions[f].save();
            })
        }
      })
      .then(function() {

        let clone = _this.get();

        // Strip functions property
        if (clone.functions) delete clone.functions;

        // Write file
        return SUtils.writeFile(path.join(_this._config.fullPath, 's-module.json'),
          JSON.stringify(clone, null, 2));
      })
      .then(function() {
        console.log('created module')
        return _this;
      })
  }

  /**
   * Create (scaffolding)
   * - Returns promise
   */

  _create() {

    let _this = this;

    return BbPromise.try(function() {

      let writeDeferred = [];

      writeDeferred.push(
        fs.mkdirSync(_this._config.fullPath),
        SUtils.writeFile(path.join(_this._config.fullPath, 's-templates.json'), '{}')
      );

      return BbPromise.all(writeDeferred);
    });
  }
}

module.exports = ServerlessModule;