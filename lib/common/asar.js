(function () {
  const asar = process.binding('atom_common_asar')
  const { Buffer } = require('buffer')
  const childProcess = require('child_process')
  const path = require('path')

  const LOCAL_DEBUG = false //
  // integrities config
  const integrities = {
    // returns integrities as stringified json.
    getIntegrity: function () {
      if (typeof this.asarIntegrities === 'undefined') {
        // default
        this.asarIntegrities = {
          checksums: {}
        }

        // get integrities from c/c++ source, if possible
        const integrityRaw = asar.getIntegrity()
        if (LOCAL_DEBUG) {
          console.log(`integrityRaw from C++: ${integrityRaw}`)
        }
        if (integrityRaw) {
          try {
            this.asarIntegrities = JSON.parse(integrityRaw)
          } catch (e) {
            // errors? nevermind! We fail with an error,
            // if an asar is called with no checksum specified
          }
        }
      }

      if (LOCAL_DEBUG) {
        console.log(
          `Found this integrities: ${JSON.stringify(this.asarIntegrities)}`
        )
      }

      // stringify contents, to be able to change this data acquisition
      // to an internal c/c++ method call, eventually.
      return JSON.stringify({
        // Note, we prefer the internal "GetAsarIntegrity" method over
        // this listing.
        // Also note, that we drop all other configuration property, if
        // available (like `externalsAllowed`). Only "checksums" are used.
        checksums: Object.assign(
          {},
          // additional files to check
          // format: <filename>: <sha512 as base64 string>
          // "configuration-manager.js": "not expected"
          {
            'identity-manager.yml': new Buffer(
              '665689bd0ea7e33dc6a07f2997a27cfbeb9a650c19974bb532a378e8ba5410eb16de15ab3ce689396780075d353bc8bf4600c90230700489b752bed60ed7899c',
              'hex'
            ).toString('base64'),
            'app.asar':
              '/TGQvoYI40OIYgKYNfnC4fUoinCxutwREf3AI5sira0rfwX+aByvV4rgsPOtOO2jkmTGVdJRqTgPCDKrISHk8A==',
            'electron.asar':
              'SJDzxX1mBCez1aHlhZvGRcAQX/PrLt9TJmLNvHmRFCCid44eGnB6To3hZQDWQ0MUrVgh9yLX5pVQ8uKFpEKCVA=='
          },
          this.asarIntegrities.checksums
        )
      })
    }
  }

  let originalFs

  if (LOCAL_DEBUG) {
    console.log(`CALLED asar.js`)
  }

  const validateIntegrity = (function () {
    if (LOCAL_DEBUG) {
      console.log(`CALLED asar.js:validateIntegrity IIFE`)
    }
    let crypto
    let originalFs
    let integrityConfig
    // map to tracked already verified files (to improve performance)
    // NOTE, this could also mean a security lack, because we don't verify files, after we
    // have verified them once...
    const checked = {}

    const hashSync = function (fd) {
      if (LOCAL_DEBUG) {
        console.log(`CALLED asar.js:validateIntegrity:hashSync`)
      }
      if (crypto == null) {
        crypto = require('crypto')
      }
      if (originalFs == null) {
        throwErrorAndExit(`Filesystem not ready.`, 'EDAMAGEDAPP')
      }

      const hash = crypto.createHash('sha512')
      const BUFFER_SIZE = Buffer.poolSize
      const buffer = Buffer.allocUnsafe(BUFFER_SIZE)
      let bytesRead
      let position = 0
      do {
        bytesRead = originalFs.readSync(fd, buffer, 0, BUFFER_SIZE, position)
        hash.update(buffer.slice(0, bytesRead))
        position += bytesRead
      } while (bytesRead === BUFFER_SIZE)
      return hash.digest('base64')
    }

    /**
     * The method verifies the integrity of the given file, if we have an expected checksum available.
     *
     * If there is no checksum, normal files won't be checked.
     * Furthermore, Asar files are always validated. If no checksum was found for an asar, the app crashes
     * with an error "EDAMAGED...".
     *
     * The verification is triggered for ALL files you load in node/main or renderer/chrome. Currently, we only support
     * a "basename -> checksum" map. Due to this, you cannot have two files with the same filename and different checksums.
     *
     * Required Interfaces:
     * fileFd.getFd() -> FileDescriptor e.g. from a command like `const fd = fs.openSync('temp.txt', 'r');`
     * integrity.getIntegrity() -> string e.g. "{\"checksums\":{\"app.asar\":\"checksum\"}}"
     *
     * @param {string} filePath path of the requested file
     * @param {{getIntegrity() => string}} integrity (asar) reference to receive the expected integrity checksum via `getIntegrity(): string`
     * @param {{getFd() => FileDescriptor}} fileFd (archive) object to get a FileDescripter via `getFd`, to calculate the actual checksum (sha512). Optional, if not set, we'll call openSync and closeSync by ourselfs. CloseSync is only called of no FD is given.
     * @param {FileSystem} _originalFs optional, fs reference (required for first call)
     */
    const validateIntegrity = function (
      filePath,
      integrity,
      fileFd,
      _originalFs
    ) {
      // make asynchronous call
      setTimeout(function () {
        if (LOCAL_DEBUG) {
          console.log(
            `CALLED asar.js:validateIntegrity:validateIntegrity with \nintegrityConfig: ${JSON.stringify(
              integrityConfig
            )}\nintegrity.getIntegrity: ${integrity.getIntegrity()}`
          )
        }
        // Setting fs reference, if not already done
        if (_originalFs && originalFs == null) {
          originalFs = _originalFs
        }

        // integrityConfig will be loaded once
        if (!integrityConfig) {
          if (integrityConfig === null) {
            throwErrorAndExit(
              `No integrity or checksums specified.`,
              'EDAMAGEDAPP'
            )
            return
          }

          const rawIntegrityString = integrity.getIntegrity()
          if (!rawIntegrityString) {
            throwErrorAndExit(`Integrity config not parsable.`, 'EDAMAGEDAPP')
            return
          }

          try {
            integrityConfig = JSON.parse(rawIntegrityString)
          } catch (e) {
            throwErrorAndExit(
              `Cannot parse integrity checksums from application: ${e}\nData: ${rawIntegrityString}`,
              'EDAMAGEDAPP'
            )
          }

          if (
            !integrityConfig ||
            !integrityConfig.checksums ||
            Object.keys(integrityConfig.checksums).length < 2
          ) {
            throwErrorAndExit(
              `Invalid integrity config. No or too few checksums.\nraw integrity config: ${rawIntegrityString}`,
              'EDAMAGEDAPP'
            )
            return
          }

          if (LOCAL_DEBUG) {
            console.log(`integrity we're using:\n${rawIntegrityString}`)
          }
        }

        // NOTE externals are always allowed, because we mostly have a folder inside our
        // HOME_DIR for configuration and further packages (see XNotar).
        /* let resourcesPath = process.resourcesPath;
        if (!filePath.startsWith(resourcesPath)) {
          if (integrityConfig.externalAllowed === true) {
            return;
          }
          throwErrorAndExit(
            `${filePath} not located in the application resources path (${resourcesPath}) but loading of external files is disallowed (externalAllowed: ${
              integrityConfig.externalAllowed
            })`,
            "EDAMAGEDAPP"
          );
        } */

        // find expected checksum by filename
        const basename = path.basename(filePath)
        const expected = integrityConfig.checksums[basename]

        if (!expected) {
          // NOTE in the renderer-process the "asar.getIntegrity" returns an empty list of checksums, because the bundle cannot be loaded.
          // always fail for asar files (that's the minimum to be specified)
          if (filePath.substr(-5) === '.asar') {
            throwErrorAndExit(
              `Application is corrupted, checksum not specified for ${filePath}\nIntegrities: ${JSON.stringify(
                integrityConfig
              )}`,
              'EDAMAGEDAPP'
            )
          }

          if (LOCAL_DEBUG) {
            console.log(
              `no checksum for external file ${basename}. That's okay.`
            )
          }

          // return with no further action, if its a normal file with no checksum specified.
          return
        }

        if (checked[basename] === true) {
          // we've already checked this file.
          if (LOCAL_DEBUG) {
            console.log(`Already checked ${basename}`)
          }
          return
        }

        // is file already open?
        const fd = fileFd ? fileFd.getFd() : originalFs.openSync(filePath, 'r')
        if (fd < 0) {
          const error = new Error(`ENOENT, ${filePath} not found`)
          error.code = 'ENOENT'
          error.errno = -2
          throw error
        }

        const actual = hashSync(fd)

        // close file, if no FD was given
        if (!fileFd) {
          originalFs.closeSync(fd)
        }

        if (expected !== actual) {
          // set checked to true for this file to avoid permanent checks with failures here!
          checked[basename] = true
          throwErrorAndExit(
            `${filePath} is corrupted, checksum mismatch.\nexpected: ${expected}\nactual  : ${actual}`,
            'EDAMAGEDFILE'
          )
        }

        // track checked state, to verify files only once.
        checked[basename] = true

        if (LOCAL_DEBUG) {
          console.log(
            `integrity of ${basename} successfully checked. (${actual})`
          )
        }
      }, 0) // setTimeout
    }

    const throwErrorAndExit = function (message, code) {
      if (LOCAL_DEBUG) {
        console.log(`CALLED asar.js:validateIntegrity:throwErrorAndExit`)
      }
      // to ensure that app will be terminated
      process.nextTick(function () {
        process.exit(1)
      })
      const error = new Error(message)
      error.code = code
      throw error
    }

    // exports.validateIntegrity = validateIntegrity;
    return validateIntegrity
  })()

  const hasProp = {}.hasOwnProperty

  // Cache asar archive objects.
  const cachedArchives = {}

  const envNoAsar =
    process.env.ELECTRON_NO_ASAR &&
    process.type !== 'browser' &&
    process.type !== 'renderer'
  const isAsarDisabled = function () {
    return process.noAsar || envNoAsar
  }

  const getOrCreateArchive = function (p) {
    // if(LOCAL_DEBUG) {
    //   console.log(`CALLED asar.js:getOrCreateArchive (${p})`)
    // }
    let archive = cachedArchives[p]
    if (archive != null) {
      return archive
    }
    archive = asar.createArchive(p)
    if (!archive) {
      return false
    }
    validateIntegrity(p, integrities, archive, originalFs)
    cachedArchives[p] = archive
    return archive
  }

  // Clean cache on quit.
  process.on('exit', function () {
    for (let p in cachedArchives) {
      if (!hasProp.call(cachedArchives, p)) continue
      cachedArchives[p].destroy()
    }
  })

  // Separate asar package's path from full path.
  const splitPath = function (p) {
    // shortcut to disable asar.
    if (isAsarDisabled()) {
      validateIntegrity(p, integrities)
      return [false]
    }

    if (Buffer.isBuffer(p)) {
      p = p.toString()
    }

    if (typeof p !== 'string') {
      validateIntegrity(p, integrities)
      return [false]
    }

    if (p.substr(-5) === '.asar') {
      return [true, p, '']
    }

    p = path.normalize(p)
    const index = p.lastIndexOf('.asar' + path.sep)
    if (index === -1) {
      validateIntegrity(p, integrities)
      return [false]
    }
    return [true, p.substr(0, index + 5), p.substr(index + 6)]
  }

  // Convert asar archive's Stats object to fs's Stats object.
  let nextInode = 0

  const uid = process.getuid != null ? process.getuid() : 0

  const gid = process.getgid != null ? process.getgid() : 0

  const fakeTime = new Date()

  const asarStatsToFsStats = function (stats) {
    return {
      dev: 1,
      ino: ++nextInode,
      mode: 33188,
      nlink: 1,
      uid: uid,
      gid: gid,
      rdev: 0,
      atime: stats.atime || fakeTime,
      birthtime: stats.birthtime || fakeTime,
      mtime: stats.mtime || fakeTime,
      ctime: stats.ctime || fakeTime,
      size: stats.size,
      isFile: function () {
        return stats.isFile
      },
      isDirectory: function () {
        return stats.isDirectory
      },
      isSymbolicLink: function () {
        return stats.isLink
      },
      isBlockDevice: function () {
        return false
      },
      isCharacterDevice: function () {
        return false
      },
      isFIFO: function () {
        return false
      },
      isSocket: function () {
        return false
      }
    }
  }

  // Create a ENOENT error.
  const notFoundError = function (asarPath, filePath, callback) {
    const error = new Error(`ENOENT, ${filePath} not found in ${asarPath}`)
    error.code = 'ENOENT'
    error.errno = -2
    if (typeof callback !== 'function') {
      throw error
    }
    process.nextTick(function () {
      callback(error)
    })
  }

  // Create a ENOTDIR error.
  const notDirError = function (callback) {
    const error = new Error('ENOTDIR, not a directory')
    error.code = 'ENOTDIR'
    error.errno = -20
    if (typeof callback !== 'function') {
      throw error
    }
    process.nextTick(function () {
      callback(error)
    })
  }

  // Create a EACCES error.
  const accessError = function (asarPath, filePath, callback) {
    const error = new Error(`EACCES: permission denied, access '${filePath}'`)
    error.code = 'EACCES'
    error.errno = -13
    if (typeof callback !== 'function') {
      throw error
    }
    process.nextTick(function () {
      callback(error)
    })
  }

  // Create invalid archive error.
  const invalidArchiveError = function (asarPath, callback) {
    const error = new Error(`Invalid package ${asarPath}`)
    if (typeof callback !== 'function') {
      throw error
    }
    process.nextTick(function () {
      callback(error)
    })
  }

  // Override APIs that rely on passing file path instead of content to C++.
  const overrideAPISync = function (module, name, arg) {
    if (arg == null) {
      arg = 0
    }
    const old = module[name]
    module[name] = function () {
      const p = arguments[arg]
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return old.apply(this, arguments)
      }

      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        invalidArchiveError(asarPath)
      }

      const newPath = archive.copyFileOut(filePath)
      if (!newPath) {
        notFoundError(asarPath, filePath)
      }

      arguments[arg] = newPath
      return old.apply(this, arguments)
    }
  }

  const overrideAPI = function (module, name, arg) {
    if (arg == null) {
      arg = 0
    }
    const old = module[name]
    module[name] = function () {
      const p = arguments[arg]
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return old.apply(this, arguments)
      }

      const callback = arguments[arguments.length - 1]
      if (typeof callback !== 'function') {
        return overrideAPISync(module, name, arg)
      }

      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return invalidArchiveError(asarPath, callback)
      }

      const newPath = archive.copyFileOut(filePath)
      if (!newPath) {
        return notFoundError(asarPath, filePath, callback)
      }

      arguments[arg] = newPath
      return old.apply(this, arguments)
    }
  }

  // Override fs APIs.
  exports.wrapFsWithAsar = function (fs) {
    originalFs = fs
    const logFDs = {}
    const logASARAccess = function (asarPath, filePath, offset) {
      if (!process.env.ELECTRON_LOG_ASAR_READS) {
        return
      }
      if (!logFDs[asarPath]) {
        const path = require('path')
        const logFilename =
          path.basename(asarPath, '.asar') + '-access-log.txt'
        const logPath = path.join(require('os').tmpdir(), logFilename)
        logFDs[asarPath] = fs.openSync(logPath, 'a')
        console.log('Logging ' + asarPath + ' access to ' + logPath)
      }
      fs.writeSync(logFDs[asarPath], offset + ': ' + filePath + '\n')
    }

    const { lstatSync } = fs
    fs.lstatSync = function (p) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return lstatSync(p)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        invalidArchiveError(asarPath)
      }
      const stats = archive.stat(filePath)
      if (!stats) {
        notFoundError(asarPath, filePath)
      }
      return asarStatsToFsStats(stats)
    }

    const { lstat } = fs
    fs.lstat = function (p, callback) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return lstat(p, callback)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return invalidArchiveError(asarPath, callback)
      }
      const stats = getOrCreateArchive(asarPath).stat(filePath)
      if (!stats) {
        return notFoundError(asarPath, filePath, callback)
      }
      process.nextTick(function () {
        callback(null, asarStatsToFsStats(stats))
      })
    }

    const { statSync } = fs
    fs.statSync = function (p) {
      const [isAsar] = splitPath(p)
      if (!isAsar) {
        return statSync(p)
      }

      // Do not distinguish links for now.
      return fs.lstatSync(p)
    }

    const { stat } = fs
    fs.stat = function (p, callback) {
      const [isAsar] = splitPath(p)
      if (!isAsar) {
        return stat(p, callback)
      }

      // Do not distinguish links for now.
      process.nextTick(function () {
        fs.lstat(p, callback)
      })
    }

    const { statSyncNoException } = fs
    fs.statSyncNoException = function (p) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return statSyncNoException(p)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return false
      }
      const stats = archive.stat(filePath)
      if (!stats) {
        return false
      }
      return asarStatsToFsStats(stats)
    }

    const { realpathSync } = fs
    fs.realpathSync = function (p) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return realpathSync.apply(this, arguments)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        invalidArchiveError(asarPath)
      }
      const real = archive.realpath(filePath)
      if (real === false) {
        notFoundError(asarPath, filePath)
      }
      return path.join(realpathSync(asarPath), real)
    }

    const { realpath } = fs
    fs.realpath = function (p, cache, callback) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return realpath.apply(this, arguments)
      }
      if (typeof cache === 'function') {
        callback = cache
        cache = void 0
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return invalidArchiveError(asarPath, callback)
      }
      const real = archive.realpath(filePath)
      if (real === false) {
        return notFoundError(asarPath, filePath, callback)
      }
      return realpath(asarPath, function (err, p) {
        if (err) {
          return callback(err)
        }
        return callback(null, path.join(p, real))
      })
    }

    const { exists } = fs
    fs.exists = function (p, callback) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return exists(p, callback)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return invalidArchiveError(asarPath, callback)
      }
      process.nextTick(function () {
        callback(archive.stat(filePath) !== false)
      })
    }

    const { existsSync } = fs
    fs.existsSync = function (p) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return existsSync(p)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return false
      }
      return archive.stat(filePath) !== false
    }

    const { access } = fs
    fs.access = function (p, mode, callback) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return access.apply(this, arguments)
      }
      if (typeof mode === 'function') {
        callback = mode
        mode = fs.constants.F_OK
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return invalidArchiveError(asarPath, callback)
      }
      const info = archive.getFileInfo(filePath)
      if (!info) {
        return notFoundError(asarPath, filePath, callback)
      }
      if (info.unpacked) {
        const realPath = archive.copyFileOut(filePath)
        return fs.access(realPath, mode, callback)
      }
      const stats = getOrCreateArchive(asarPath).stat(filePath)
      if (!stats) {
        return notFoundError(asarPath, filePath, callback)
      }
      if (mode & fs.constants.W_OK) {
        return accessError(asarPath, filePath, callback)
      }
      process.nextTick(function () {
        callback()
      })
    }

    const { accessSync } = fs
    fs.accessSync = function (p, mode) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return accessSync.apply(this, arguments)
      }
      if (mode == null) {
        mode = fs.constants.F_OK
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        invalidArchiveError(asarPath)
      }
      const info = archive.getFileInfo(filePath)
      if (!info) {
        notFoundError(asarPath, filePath)
      }
      if (info.unpacked) {
        const realPath = archive.copyFileOut(filePath)
        return fs.accessSync(realPath, mode)
      }
      const stats = getOrCreateArchive(asarPath).stat(filePath)
      if (!stats) {
        notFoundError(asarPath, filePath)
      }
      if (mode & fs.constants.W_OK) {
        accessError(asarPath, filePath)
      }
    }

    const { readFile } = fs
    fs.readFile = function (p, options, callback) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return readFile.apply(this, arguments)
      }
      if (typeof options === 'function') {
        callback = options
        options = {
          encoding: null
        }
      } else if (typeof options === 'string') {
        options = {
          encoding: options
        }
      } else if (options === null || options === undefined) {
        options = {
          encoding: null
        }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }
      const { encoding } = options

      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return invalidArchiveError(asarPath, callback)
      }
      const info = archive.getFileInfo(filePath)
      if (!info) {
        return notFoundError(asarPath, filePath, callback)
      }
      if (info.size === 0) {
        return process.nextTick(function () {
          callback(null, encoding ? '' : new Buffer(0))
        })
      }
      if (info.unpacked) {
        const realPath = archive.copyFileOut(filePath)
        return fs.readFile(realPath, options, callback)
      }

      const buffer = new Buffer(info.size)
      const fd = archive.getFd()
      if (!(fd >= 0)) {
        return notFoundError(asarPath, filePath, callback)
      }
      logASARAccess(asarPath, filePath, info.offset)
      fs.read(fd, buffer, 0, info.size, info.offset, function (error) {
        callback(error, encoding ? buffer.toString(encoding) : buffer)
      })
    }

    const { readFileSync } = fs
    fs.readFileSync = function (p, options) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return readFileSync.apply(this, arguments)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        invalidArchiveError(asarPath)
      }
      const info = archive.getFileInfo(filePath)
      if (!info) {
        notFoundError(asarPath, filePath)
      }
      if (info.size === 0) {
        if (options) {
          return ''
        } else {
          return new Buffer(0)
        }
      }
      if (info.unpacked) {
        const realPath = archive.copyFileOut(filePath)
        return fs.readFileSync(realPath, options)
      }
      if (!options) {
        options = {
          encoding: null
        }
      } else if (typeof options === 'string') {
        options = {
          encoding: options
        }
      } else if (typeof options !== 'object') {
        throw new TypeError('Bad arguments')
      }
      const { encoding } = options
      const buffer = new Buffer(info.size)
      const fd = archive.getFd()
      if (!(fd >= 0)) {
        notFoundError(asarPath, filePath)
      }
      logASARAccess(asarPath, filePath, info.offset)
      fs.readSync(fd, buffer, 0, info.size, info.offset)
      if (encoding) {
        return buffer.toString(encoding)
      } else {
        return buffer
      }
    }

    const { readdir } = fs
    fs.readdir = function (p, callback) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return readdir.apply(this, arguments)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return invalidArchiveError(asarPath, callback)
      }
      const files = archive.readdir(filePath)
      if (!files) {
        return notFoundError(asarPath, filePath, callback)
      }
      process.nextTick(function () {
        callback(null, files)
      })
    }

    const { readdirSync } = fs
    fs.readdirSync = function (p) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return readdirSync.apply(this, arguments)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        invalidArchiveError(asarPath)
      }
      const files = archive.readdir(filePath)
      if (!files) {
        notFoundError(asarPath, filePath)
      }
      return files
    }

    const { internalModuleReadFile } = process.binding('fs')
    process.binding('fs').internalModuleReadFile = function (p) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return internalModuleReadFile(p)
      }
      const archive = getOrCreateArchive(asarPath)
      if (!archive) {
        return
      }
      const info = archive.getFileInfo(filePath)
      if (!info) {
        return
      }
      if (info.size === 0) {
        return ''
      }
      if (info.unpacked) {
        const realPath = archive.copyFileOut(filePath)
        return fs.readFileSync(realPath, {
          encoding: 'utf8'
        })
      }
      const buffer = new Buffer(info.size)
      const fd = archive.getFd()
      if (!(fd >= 0)) {
        return
      }
      logASARAccess(asarPath, filePath, info.offset)
      fs.readSync(fd, buffer, 0, info.size, info.offset)
      return buffer.toString('utf8')
    }

    const { internalModuleStat } = process.binding('fs')
    process.binding('fs').internalModuleStat = function (p) {
      const [isAsar, asarPath, filePath] = splitPath(p)
      if (!isAsar) {
        return internalModuleStat(p)
      }
      const archive = getOrCreateArchive(asarPath)

      // -ENOENT
      if (!archive) {
        return -34
      }
      const stats = archive.stat(filePath)

      // -ENOENT
      if (!stats) {
        return -34
      }
      if (stats.isDirectory) {
        return 1
      } else {
        return 0
      }
    }

    // Calling mkdir for directory inside asar archive should throw ENOTDIR
    // error, but on Windows it throws ENOENT.
    // This is to work around the recursive looping bug of mkdirp since it is
    // widely used.
    if (process.platform === 'win32') {
      const { mkdir } = fs
      fs.mkdir = function (p, mode, callback) {
        if (typeof mode === 'function') {
          callback = mode
        }
        const [isAsar, , filePath] = splitPath(p)
        if (isAsar && filePath.length) {
          return notDirError(callback)
        }
        mkdir(p, mode, callback)
      }

      const { mkdirSync } = fs
      fs.mkdirSync = function (p, mode) {
        const [isAsar, , filePath] = splitPath(p)
        if (isAsar && filePath.length) {
          notDirError()
        }
        return mkdirSync(p, mode)
      }
    }

    // Executing a command string containing a path to an asar
    // archive confuses `childProcess.execFile`, which is internally
    // called by `childProcess.{exec,execSync}`, causing
    // Electron to consider the full command as a single path
    // to an archive.
    ['exec', 'execSync'].forEach(function (functionName) {
      const old = childProcess[functionName]
      childProcess[functionName] = function () {
        const processNoAsarOriginalValue = process.noAsar
        process.noAsar = true
        try {
          return old.apply(this, arguments)
        } finally {
          process.noAsar = processNoAsarOriginalValue
        }
      }
    })

    overrideAPI(fs, 'open')
    overrideAPI(childProcess, 'execFile')
    overrideAPISync(process, 'dlopen', 1)
    overrideAPISync(require('module')._extensions, '.node', 1)
    overrideAPISync(fs, 'openSync')
    overrideAPISync(childProcess, 'execFileSync')
  }
})()
