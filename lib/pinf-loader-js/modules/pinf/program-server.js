
var API = require("../../api"),
    PINF_LOADER = require("./loader");

var JSGI = exports.JSGI = function(options)
{
    this.API = options.api;

    this.routes = {};
    for (var path in options.map)
    {
        if (path.charAt(0) != "/")
            throw new Error("Path must begin with '/'");

        if (!/\.js$/.test(path))
            throw new Error("Path must end in '.js'");

        if (typeof options.map[path].basePath != "undefined" && !/\/$/.test())
            options.map[path].basePath += "/";

        // Add the main program route
        this.routes[path] = {
            expr: new RegExp("^" + path.replace(/(\/|\\)/g, "\\$1") + "$"),
            path: path,
            options: options.map[path]
        }
        
        // Add a route to load extra modules
        this.routes[path + "/module/"] = {
            expr: new RegExp("^" + path.replace(/(\/|\\)/g, "\\$1") + "\/module\/(.*)$"),
            path: path,
            options: options.map[path],
            load: "module"
        }
        
        // Add a route to load extra packages
        this.routes[path + "/package/"] = {
            expr: new RegExp("^" + path.replace(/(\/|\\)/g, "\\$1") + "\/package\/(.*)$"),
            path: path,
            options: options.map[path],
            load: "package"
        }
    }
}

JSGI.prototype.responder = function(app)
{
    var self = this;
    
    return function(request)
    {
        var deferred = self.API.PROMISE.defer();

        var responding;

        try
        {
            responding = self.respond(request, function(response)
            {
                deferred.resolve(response);
            });
        }
        catch(e)
        {
            // TODO: Use error reporter here instead of print
            API.SYSTEM.print("\0red(" + e + "\n\n" + e.stack + "\0)\n");
            throw e;
        }

        if (!responding)
        {
            if (typeof app != "undefined")
                deferred.resolve(app(request));
            else
                deferred.resolve({
                    status: 404,
                    headers: {
                        "content-type": "text/plain"
                    },
                    body: [
                        "File not found!"
                    ]
                });
        }

        return deferred.promise;
    }
}

JSGI.prototype.respond = function(request, callback)
{
    var route;
    for (route in this.routes)
    {
        if (this.routes[route].expr.test(request.pathInfo))
        {
            route = this.routes[route];
            break;
        }
        else
            route = void 0;
    }
    if (typeof route == "undefined")
        return false;

    function sendResponse(body)
    {
        callback({
            status: 200,
            headers: {
                "content-type": "text/javascript",
                "transfer-encoding": "chunked"
                // NOTE: Do not set content length as length is not accurate for some JS files                
//                "content-length": (body = body.join("\n")).length
            },
            body: [
                body.join("\n")
            ]
        });
    }

    if (typeof route.options.programPath != "undefined")
    {
        function send(sandbox)
        {
            var body = [],
                path,
                deps,
                parts,
                descriptor,
                pkg,
                modules,
                id;

            var port = ((request.port)?request.port:80);

            var basePath = route.options.basePath || sandbox.getMainModuleDir();

            var config = {
                url: "http" + ((port==80)?"":"s") + "://" + request.host + ":" + port + request.pathInfo,
                mainModuleDir: "/" + request.host + ":" + port + route.path
            }
            config.mainContext = config.mainModuleDir + "/" + sandbox.packageForId(sandbox.program.getBootPackages()[0]["_package-0"].location).getHashId();

            function rewritePath(path, packageIDOnly)
            {
                var parts = path.split("@/");
                if (parts.length == 2)
                {
                    var pkg = sandbox.packageForId(parts[0]);
                    if (pkg)
                        return pkg.getHashId() + "@/" + parts[1];
                }
                
                if (path.substring(0, basePath.length) == basePath)
                    return path.substring(basePath.length);

                var pkg = sandbox.packageForId(path);
                if (pkg)
                {
                    if (packageIDOnly)
                        return pkg.getHashId();
                    else
                        return rewritePath(pkg.getMainId());
                }

                if (typeof route.options.rewritePaths == "undefined")
                    throw new Error("Path '" + path + "' must be rewritten via 'rewritePaths' map property. Property is not set!");

                var paths = route.options.rewritePaths.filter(function(filterPath)
                {
                    return (path.substring(0, filterPath[0].length) == filterPath[0]);
                });

                if (paths.length == 0)
                    throw new Error("No matching path in 'rewritePaths' map property found for path '" + path + "'.");

                return paths[0][1] + path.substring(paths[0][0].length);
            }

            var packageDescriptors = {
                "mapped": {},
                "sent": {}
            };

            function memoizeModule(moduleIdentifier, dependencies, moduleFactory)
            {
                // Pull out plugin if applicable
                var plugin;
                if (typeof moduleIdentifier == "string")
                {
                    var m = moduleIdentifier.match(/^(\w*)!(.*)$/);
                    if (m)
                    {
                        plugin = m[1];
                        moduleIdentifier = m[2];
                    }
                }

                parts = moduleIdentifier.split("@/");

                deps = "";
                if (dependencies.length > 0)
                    deps = "'" + dependencies.join("','") + "'";

                // Rewrite package modules and mappings
                if (parts[1] == "package.json")
                {
                    packageDescriptors.sent[rewritePath(parts[0], true)] = true;
                    descriptor = API.UTIL.deepCopy(moduleFactory());
                    if (typeof descriptor.modules != "undefined")
                    {
                        for( var path in descriptor.modules)
                        {
                            if (typeof descriptor.modules[path].location == "undefined")
                                throw new Error("There should be a location property in the mapping locator by now!");
                            packageDescriptors.mapped[rewritePath(descriptor.modules[path].location, true)] = true;
                            descriptor.modules[path].location = config.mainModuleDir + "/" + rewritePath(descriptor.modules[path].location, true);
                            delete descriptor.modules[path].id;
                        }
                    }
                    if (typeof descriptor.mappings != "undefined")
                    {
                        for( var alias in descriptor.mappings)
                        {
                            if (typeof descriptor.mappings[alias].location == "undefined")
                                throw new Error("There should be a location property in the mapping locator by now!");
                            packageDescriptors.mapped[rewritePath(descriptor.mappings[alias].location, true)] = true;
                            descriptor.mappings[alias].location = config.mainModuleDir + "/" + rewritePath(descriptor.mappings[alias].location, true);
                            delete descriptor.mappings[alias].id;
                        }
                    }
                    moduleFactory = "function() { return " + API.JSON.stringify(descriptor) + "; }";
                }

                pkg = sandbox.packageForId(parts[0]);
                if (pkg)
                {
                    id = config.mainModuleDir + "/" + pkg.getHashId() + "@/" + parts[1];
                }
                else
                if (parts.length == 1)
                {
                    id = config.mainModuleDir + rewritePath(API.FILE.realpath(parts[0]));
                }
                else
                    throw new Error("NYI - " + parts);

                body.push("require.memoize(" + ((typeof plugin != "undefined")?"'"+plugin+"!'+":"") + "bravojs.realpath('" + id + "'), [" + deps + "], " + moduleFactory + ");");
            }
            
            function memoizeMissingPackageDescriptors()
            {
                for (var pkgId in packageDescriptors.mapped)
                {
                    if (typeof packageDescriptors.sent[pkgId] == "undefined")
                    {
                        pkg = sandbox.packageForHash(pkgId);
                        memoizeModule(pkg.path + "@/package.json", [], function()
                        {
                            return pkg.normalizedDescriptor.json;
                        });
                    }
                }
            }

            if (typeof route.load != "undefined")
            {
                // Prepare extra load payload

                var pathInfoParts = route.expr.exec(request.pathInfo),
                    pathParts = pathInfoParts[1].split("@/");
                if (pathParts.length == 2 && (pkg = sandbox.packageForHash(pathParts[0])))
                {
                    path = pkg.path + "@/" + pathParts[1];
                }
                else
                {
                    // The client converted ../ to __/ to keep the directory up path segments in tact
                    path = basePath + pathInfoParts[1].replace(/_{2}\//g, "../");
                }

                // Collect all existing modules so we can determine new ones
                modules = {};
                sandbox.forEachModule(function(moduleIdentifier)
                {
                    modules[moduleIdentifier] = true;
                });

                function sendModules(loadedId)
                {
                    // Memoize new modules

                    sandbox.forEachModule(function(moduleIdentifier, dependencies, moduleFactory)
                    {
                        if(!modules[moduleIdentifier])
                            memoizeModule(moduleIdentifier, dependencies, moduleFactory);
                    });
                    memoizeMissingPackageDescriptors();

                    // Set loaded ID if applicable
                    
                    if (typeof loadedId != "undefined")
                        body.push("__bravojs_loaded_moduleIdentifier = bravojs.realpath('" + config.mainModuleDir + "/" + rewritePath(loadedId) + "');");

                    // Send response

                    sendResponse(body);
                }

                if (route.load === "module")
                {
                    sandbox.load(path, sendModules);
                }
                else
                if (route.load === "package")
                {
                    sandbox.load({
                        location: path
                    }, sendModules);
                }
                else
                    throw new Error("NYI");
            }
            else
            {
                // Prepare initial program payload
                
                // Configure BravoJS

                body.push("bravojs = " + API.JSON.stringify(config) + ";");

                // Pull in BravoJS and plugins

                path = API.ENV.loaderRoot + "/lib/pinf-loader-js/bravojs/global-es5.js";
                body.push(API.FILE.read(path));

                path = API.ENV.loaderRoot + "/lib/pinf-loader-js/bravojs/bravo.js";
                body.push(API.FILE.read(path));

                path = API.ENV.loaderRoot + "/lib/pinf-loader-js/bravojs/plugins/packages/packages.js";
                body.push(API.FILE.read(path));

                path = API.ENV.loaderRoot + "/lib/pinf-loader-js/bravojs/plugins/packages/loader.js";
                body.push(API.FILE.read(path));

                // Memoize modules

                sandbox.forEachModule(memoizeModule);
                memoizeMissingPackageDescriptors();
    
                // Boot the program
    
                var dependencies = sandbox.program.getBootPackages();
                for (var i=0, ic=dependencies.length ; i<ic ; i++ )
                {
                    if (typeof dependencies[i]["_package-" + i].location != "undefined")
                    {
                        pkg = sandbox.packageForId(dependencies[i]["_package-" + i].location);
                        dependencies[i]["_package-" + i] = {
                            id: pkg.getHashId()
                        }
                    }
                    else
                        throw new Error("NYI");
                }
    
                body.push("(function() {");
                    body.push("var env = {};");
                    body.push("module.declare(" + API.JSON.stringify(dependencies) + ", function(require, exports, module) {");
                        for (var i=0, ic=dependencies.length ; i<ic ; i++ )
                            body.push("require('_package-" + i + "').main(env);");
                    body.push("});");
                body.push("})();");

                // Send response

                sendResponse(body);
            }
        }

        // Always create a new sandbox for the request
        // TODO: Config to exclude modules
        new PINF_LOADER.Sandbox(
        {
            programPath: route.options.programPath
        },
        function done(sandbox)
        {
            send(sandbox);
        });
    }
    else
        throw new Error("Unrecognized route target options '" + Object.keys(route.options) + "'");

    return true;
}