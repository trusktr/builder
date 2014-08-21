var System = require('systemjs');
var traceur = require('traceur');

var ScopeTransformer = traceur.get('codegeneration/ScopeTransformer').ScopeTransformer;
var parseExpression = traceur.get('codegeneration/PlaceholderParser').parseExpression;

var compiler = new traceur.Compiler();

var CJSRequireTransformer = require('./cjs').CJSRequireTransformer;

// First of two-pass transform
// lists number of define statements, the named module it defines (if any), and deps
// second pass will do rewriting based on this info
// we set this.isAnon, which is true if there is one named define, or one anonymous define
// if there are more than one anonymous defines, it is invalid
function AMDDependenciesTransformer(map) {
  // optional mapping function
  this.map = map;
  this.anonDefine = false;
  this.defineBundle = false;
  this.deps = [];
  return ScopeTransformer.call(this, 'define');
}
AMDDependenciesTransformer.prototype = Object.create(ScopeTransformer.prototype);
AMDDependenciesTransformer.prototype.filterAMDDeps = function(deps) {
  var newDeps = [];
  deps.forEach(function(dep) {
    if (['require', 'exports', 'module'].indexOf(dep) != -1)
      return;
    newDeps.push(dep);
  });
  return newDeps;
}
AMDDependenciesTransformer.prototype.transformCallExpression = function(tree) {
  if (!tree.operand.identifierToken || tree.operand.identifierToken.value != 'define')
    return ScopeTransformer.prototype.transformCallExpression.call(this, tree);

  var args = tree.args.args;
  var name = args[0].type === 'LITERAL_EXPRESSION' && args[0].literalToken.processedValue;

  // anonymous define
  if (!name) {
    // already defined anonymously -> throw
    if (this.anonDefine)
      throw "Multiple defines for anonymous module";
    this.anonDefine = true;
  }
  // named define
  else {
    // if we don't have any other defines, 
    // then let this be an anonymous define
    if (!this.anonDefine && !this.defineBundle)
      this.anonDefine = true;

    // otherwise its a bundle only
    else {
      this.anonDefine = false;
      this.deps = [];
    }

    // the above is just to support single modules of the form:
    // define('jquery')
    // still loading anonymously
    // because it is done widely enough to be useful

    // note this is now a bundle
    this.defineBundle = true;
  }

  // only continue to extracting dependencies if we're anonymous
  if (!this.anonDefine)
    return;

  var depTree;

  if (args[0].type === 'ARRAY_LITERAL_EXPRESSION')
    depTree = args[0];
  else if (args[1] && args[1].type == 'ARRAY_LITERAL_EXPRESSION')
    depTree = args[1];

  if (depTree) {
    // apply the map to the tree
    if (this.map)
      depTree.elements = depTree.elements.map(this.map);
    this.deps = this.filterAMDDeps(depTree.elements.map(function(dep) {
      return dep.literalToken.processedValue;
    }));
    return;
  }

  var cjsFactory;

  if (args[0].type == 'FUNCTION_EXPRESSION')
    cjsFactory = args[0];
  else if (args[0].type == 'LITERAL_EXPRESSION' && args[1] && args[1].type == 'FUNCTION_EXPRESSION')
    cjsFactory = args[1];

  if (cjsFactory) {
    // now we need to do a scope transformer for the require function at this position
    var fnParameters = cjsFactory.parameterList.parameters;
    var reqName = fnParameters[0] && fnParameters[0].parameter.binding.identifierToken.value;
    
    // now we create a new scope transformer and apply it to this function to find every call of
    // the function reqName, noting the require
    var cjsRequires = new CJSRequireTransformer(reqName, this.map);
    cjsFactory.body = cjsRequires.transformAny(cjsFactory.body);
    this.deps = this.filterAMDDeps(cjsRequires.requires);
  }
}

// AMD System.register transpiler
// This is the second of the two pass transform
function AMDDefineRegisterTransformer(load, isAnon, depMap) {
  this.load = load;
  this.isAnon = isAnon;
  this.depMap = depMap;
  return ScopeTransformer.call(this, 'define');
}
AMDDefineRegisterTransformer.prototype = Object.create(ScopeTransformer.prototype);
AMDDefineRegisterTransformer.prototype.transformCallExpression = function(tree) {
  if (!tree.operand.identifierToken || tree.operand.identifierToken.value != 'define')
    return ScopeTransformer.prototype.transformCallExpression.call(this, tree);

  var self = this;
  var args = tree.args.args;

  // only when "exports" is present as an argument
  // or dependency, does it become "this" for AMD
  // otherwise "this" must reference the global
  var bindToExports = false;
  /*
    define(['some', 'deps', 'require'], function(some, deps, require) {

    });

    ->

    System.register(['some', 'deps', 'require'], false, function(__require, __exports, __module) {
      (function(some, deps, require) {

      })(__require('some'), __require('deps'), __require);
    });

    define(['dep'], factory)

    ->

    System.register(['dep'], false, function(__require, __exports, __module) {
      return (factory)(__require('dep'));
    });


    define('jquery', [], factory)

    ->

    System.register([], false, factory);

    IF it is the only define

    otherwise we convert an AMD bundle into a register bundle:

    System.register('jquery', [], false, factory);

    Note that when __module is imported, we decorate it with 'uri' and an empty 'config' function
  */
  if (args[0].type === 'ARRAY_LITERAL_EXPRESSION' || args[0].type === 'LITERAL_EXPRESSION') {

    var name = this.load.name;
    var deps = args[0];
    var factory = args[1];

    if (args[0].type === 'LITERAL_EXPRESSION') {
      if (!this.isAnon)
        name = args[0].literalToken.processedValue;
      deps = args[1];
      factory = args[2];
    }

    if (deps.elements.length != 0) {
      // filter out the special deps "require", "exports", "module"
      var requireIndex, exportsIndex, moduleIndex;

      var depNames = deps.elements.map(function(dep) {
        var depValue = dep.literalToken.processedValue
        if (self.depMap[depValue])
          depValue = self.depMap[depValue];
        return depValue;
      });

      var depCalls = depNames.map(function(depName) {
        return "__require('" + depName + "')";
      });

      requireIndex = depNames.indexOf('require');
      exportsIndex = depNames.indexOf('exports');
      moduleIndex = depNames.indexOf('module');

      var exportsIndexD = exportsIndex, moduleIndexD = moduleIndex;

      if (requireIndex != -1) {
        depCalls.splice(requireIndex, 1, '__require');
        deps.elements.splice(requireIndex, 1);
        if (exportsIndex > requireIndex)
          exportsIndexD--;
        if (moduleIndex > requireIndex)
          moduleIndexD--;
      }
      if (exportsIndex != -1) {
        bindToExports = true;
        depCalls.splice(exportsIndex, 1, '__exports');
        deps.elements.splice(exportsIndexD, 1);
        if (moduleIndexD > exportsIndexD)
          moduleIndexD--;
      }
      if (moduleIndex != -1) {
        depCalls.splice(moduleIndex, 1, '__module');
        deps.elements.splice(moduleIndexD, 1);
      }
    }

    if (depCalls)
      return parseExpression([
        'System.register("' + name + '",',
        ', false, function(__require, __exports, __module) {\n  return (',
        ').call(' + (bindToExports ? '__exports' : 'this') + ', ',
        ');\n});'
      ], deps, factory, parseExpression([depCalls.join(', ')]));
    else
      return parseExpression([
        'System.register("' + name + '",',
        ', false, function(__require, __exports, __module) {\n  return (',
        ').call(' + (bindToExports ? '__exports' : 'this') + ');\n});'
      ], deps, factory);
  }

    

  /*
    define({ })

    ->

    System.register([], false, function() {
      return { };
    });
  */
  if (args[0].type == 'OBJECT_LITERAL_EXPRESSION') {
    return parseExpression([
      'System.register("' + this.load.name + '", [], false, function() {\n  return ',
      ';\n});'
    ], args[0]);
  }

  /*
    define(function(require, exports, module) {
      require('some-dep');
    });

    ->

    System.register(['some-dep'], false, function(require, exports, module) {
      require('some-dep');
    });

    Note there is a strange subtlety in RequireJS here.

    If there is one argument, 
  */
  if (args[0].type == 'FUNCTION_EXPRESSION') {
    // system loader already extracted the deps for us
    var requires = this.load.deps.map(function(dep) {
      return self.depMap[dep] || dep;
    });

    var params = args[0].parameterList.parameters;
    if (params.length > 1)
      bindToExports = true;

    if (bindToExports)
      return parseExpression([
        'System.register("' + this.load.name + '", ' + JSON.stringify(requires) + ', false, function(__require, __exports, __module) {\n'
      + '(',
        ').call(__exports, __require, __exports, __module);\n'
      + '});'
      ], args[0]);
    else
      return parseExpression([
        'System.register("' + this.load.name + '", ' + JSON.stringify(requires) + ', false, ',
        ');'
      ], args[0]);
  }
}

// override System instantiate to handle AMD dependencies
exports.attach = function(loader) {
  var systemInstantiate = loader.instantiate;
  loader.instantiate = function(load) {
    var result = systemInstantiate.call(this, load);

    if (load.metadata.format == 'amd') {
      // extract AMD dependencies using tree parsing
      var output = compiler.stringToTree({content: load.source});
      if (output.errors.length)
        return Promise.reject(output.errors[0]);
      load.metadata.parseTree = output;
      var depTransformer = new AMDDependenciesTransformer();
      depTransformer.transformAny(output.tree);

      // we store the results as meta
      load.metadata.isAnon = depTransformer.anonDefine;

      return {
        deps: depTransformer.deps,
        execute: function() {}
      };
    }

    return result;
  }
}

exports.remap = function(source, map) {
  var output = compiler.stringToTree({content: source, options: options});
  if (output.errors.length)
    return Promise.reject(output.errors[0]);
  var transformer = new AMDDependenciesTransformer(map);
  output.tree = transformer.transformAny(output.tree);
  output = compiler.treeToString(output);
  if (output.errors.length)
    return Promise.reject(output.errors[0]);

  return Promise.resolve({ source: output.js });
}


// converts anonymous AMDs into named AMD for the module
exports.compile = function(load, normalize, loader) {
  var output = load.metadata.parseTree;
  var transformer = new AMDDefineRegisterTransformer(load, load.metadata.isAnon, normalize ? load.depMap : {});
  output.tree = transformer.transformAny(output.tree);
  var output = compiler.treeToString(output);
  if (output.errors.length)
    return Promise.reject(output.errors[0]);

  // because we've blindly replaced the define statement from AMD with a System.register call
  // we have to ensure we still trigger any AMD guard statements in the code by creating a dummy define which isn't called
  return Promise.resolve({
    source: '(function() {\nfunction define(){};  define.amd = true;\n  ' + output.js.replace(/\n/g, '\n  ') + '})();'
  });
}
