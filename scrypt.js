/* - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -  */
/* Scrypt password-based key derivation function.                              (c) C.Veness 2018  */
/*                                                                                   MIT Licence  */
/*                                                                                                */
/* The function derives one or more secret keys from a secret string. It is based on memory-hard  */
/* functions, which offer added protection against attacks using custom hardware.                 */
/*                                                                                                */
/* www.tarsnap.com/scrypt.html, tools.ietf.org/html/rfc7914                                       */
/*                                                                                                */
/* This implementation is a zero-dependency wrapper providing access to the OpenSSL scrypt        */
/* function, returning a derived key with scrypt parameters and salt in Colin Percival's standard */
/* file header format.                                                                            */
/*                                                                                                */
/* Requires NodeJS 10.5.0 or above.                                                               */
/* - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -  */

const crypto      = require('crypto');                 // nodejs.org/api/crypto.html
const performance = require('perf_hooks').performance; // nodejs.org/api/perf_hooks.html
const os          = require('os');                     // nodejs.org/api/os.html
const TextEncoder = require('util').TextEncoder;       // nodejs.org/api/util.html
const promisify   = require('util').promisify;         // nodejs.org/api/util.html

crypto.scrypt = promisify(crypto.scrypt);


class Scrypt {

    /**
     * Produce derived key using scrypt as a key derivation function.
     *
     * @param   {string}   passphrase - secret value such as a password from which key is to be derived.
     * @param   {Object}   params - scrypt parameters.
     * @param   {number}   params.logN - CPU/memory cost parameter.
     * @param   {number=8} params.r - Block size parameter.
     * @param   {number=1} params.p - Parallelization parameter.
     * @returns {string} Derived key (base-64 encoded).
     *
     * @example
     *   const key = Scrypt.kdf('my secret password', { logN: 15 });
     */
    static async kdf(passphrase, params) {
        if (typeof passphrase != 'string') throw new TypeError('Passphrase must be a string');
        if (typeof params != 'object' || params == null) throw new TypeError('Params must be an object');

        // defaults for r, p
        if (params.r == undefined) params.r = 8;
        if (params.p == undefined) params.p = 1;

        // range-check logN, r, p
        const logN = Math.round(params.logN);
        const r = Math.round(params.r);
        const p = Math.round(params.p);
        if (isNaN(logN) || logN != params.logN) throw new RangeError(`Parameter logN must be an integer; received ${params.logN}`);
        if (logN < 1 || logN > 30) throw new RangeError(`Parameter logN must be between 1 and 30; received ${params.logN}`);
        if (isNaN(r) || r != params.r) throw new RangeError(`Parameter r must be an integer; received ${params.r}`);
        if (isNaN(p) || p != params.p) throw new RangeError(`Parameter p must be an integer; received ${params.p}`);

        // the derived key is 96 bytes: use an ArrayBuffer to view it in different formats
        const buffer = new ArrayBuffer(96);

        // a structured view of the derived key
        const struct = {
            scrypt:   new Uint8Array(buffer,  0,  6),
            params: {
                v:    new DataView(buffer,    6,  1),
                logN: new DataView(buffer,    7,  1),
                r:    new DataView(buffer,    8,  4),
                p:    new DataView(buffer,   12,  4),
            },
            salt:     new Uint8Array(buffer, 16, 32),
            checksum: new Uint8Array(buffer, 48, 16),
            hmachash: new Uint8Array(buffer, 64, 32),
        };

        // set params
        struct.scrypt.set(new TextEncoder().encode('scrypt')); // convert string to Uint8Array
        struct.params.logN.setUint8(0, logN);
        struct.params.r.setUint32(0, r, false); // big-endian
        struct.params.p.setUint32(0, p, false); // big-endian

        // set salt
        struct.salt.set(crypto.randomBytes(32));

        // set checksum of params & salt
        const prefix48 = new Uint8Array(buffer,  0, 48);
        struct.checksum.set(crypto.createHash('sha256').update(prefix48).digest().slice(0, 16));

        // set HMAC hash from scrypt-derived key
        try {
            params = {
                N:      2**logN,
                r:      r,
                p:      p,
                maxmem: 2**31-1, // 2GB is maximum maxmem allowed
            };
            // apply scrypt kdf to salt to derive hmac key
            const hmacKey = await crypto.scrypt(passphrase, struct.salt, 64, params);

            // get hmachash of params, salt, & checksum, using 1st 32 bytes of scrypt hash as key
            const prefix64 = new Uint8Array(buffer,  0, 64);
            const hmacHash = crypto.createHmac('sha256', hmacKey.slice(32)).update(prefix64).digest();
            struct.hmachash.set(hmacHash);

            // convert key to base-64 string
            const linear = new Uint8Array(buffer, 0, 96);
            const base64 = Buffer.from(linear).toString('base64');

            return base64;
        } catch (e) {
            throw new Error(e); // localise error to this function
        }
    }


    /**
     * Check whether key was generated from passphrase.
     *
     * @param {string} key - Derived base64 key obtained from Scrypt.kdf().
     * @param {string} passphrase - Passphrase originally used to generate key.
     * @returns {boolean} True if key was generated from passphrase.
     *
     * @example
     *   const ok = Scrypt.verify(key, 'my secret password'; // => true
     */
    static async verify(key, passphrase) {
        if (typeof key != 'string') throw new TypeError('Key must be a string');
        if (typeof passphrase != 'string') throw new TypeError('Passphrase must be a string');
        if (key.length != 128) throw new RangeError('Invalid key');

        // the derived key is 96 bytes: use an ArrayBuffer to view it in different formats
        const buffer = new ArrayBuffer(96);

        // a linear byte-stream view of the derived key
        const linear = new Uint8Array(buffer, 0, 96);
        linear.set(Buffer.from(key, 'base64'));

        // a structured view of the derived key
        const struct = {
            scrypt:   new Uint8Array(buffer,  0,  6),
            params: {
                v:    new DataView(buffer,    6,  1),
                logN: new DataView(buffer,    7,  1),
                r:    new DataView(buffer,    8,  4),
                p:    new DataView(buffer,   12,  4),
            },
            salt:     new Uint8Array(buffer, 16, 32),
            checksum: new Uint8Array(buffer, 48, 16),
            hmachash: new Uint8Array(buffer, 64, 32),
        };

        // verify checksum of params & salt

        const prefix48 = new Uint8Array(buffer,  0, 48);
        const checksum = crypto.createHash('sha256').update(prefix48).digest().slice(0, 16);

        if (checksum.toString('base64') != Buffer.from(struct.checksum).toString('base64')) return false;

        // rehash scrypt-derived key
        try {
            const params = {
                N:      2**struct.params.logN.getUint8(0),
                r:      struct.params.r.getUint32(0, false), // big-endian
                p:      struct.params.p.getUint32(0, false), // big-endian
                maxmem: 2**31-1, // 2GB is maximum allowed
            };

            // apply scrypt kdf to salt to derive hmac key
            const hmacKey = await crypto.scrypt(passphrase, struct.salt, 64, params);

            // get hmachash of params, salt, & checksum, using 1st 32 bytes of scrypt hash as key
            const prefix64 = new Uint8Array(buffer, 0, 64);
            const hmacHash = crypto.createHmac('sha256', hmacKey.slice(32)).update(prefix64).digest();

            // verify hash
            if (hmacHash.toString('base64') != Buffer.from(struct.hmachash).toString('base64')) return false;

            return true;
        } catch (e) {
            return false; // ???
        }
    }


    /**
     * View scrypt parameters which were used to derive key.
     *
     * @param {string} key
     * @returns {Object} Scrypt parameters logN, r, p.
     *
     * @example
     *   const key = await Scrypt.kdf('my secret password', { logN: 15 } );
     *   const params = Scrypt.viewParams(key); // => { logN: 15, r: 8, p: 1 }
     */
    static viewParams(key) {
        if (typeof key != 'string') throw new TypeError('Key must be a string');
        if (key.length != 128) throw new RangeError('Invalid key');

        // the derived key is 96 bytes: use an ArrayBuffer to view it in different formats
        const buffer = new ArrayBuffer(96);

        // a linear byte-stream view of the derived key
        const linear = new Uint8Array(buffer, 0, 96);
        linear.set(Buffer.from(key, 'base64'));

        // a structured view of the derived key
        const struct = {
            scrypt:   new Uint8Array(buffer,  0,  6),
            params: {
                v:    new DataView(buffer,    6,  1),
                logN: new DataView(buffer,    7,  1),
                r:    new DataView(buffer,    8,  4),
                p:    new DataView(buffer,   12,  4),
            },
            salt:     new Uint8Array(buffer, 16, 32),
            checksum: new Uint8Array(buffer, 48, 16),
            hmachash: new Uint8Array(buffer, 64, 32),
        };

        const params = {
            logN: struct.params.logN.getUint8(0),
            r:    struct.params.r.getUint32(0, false), // big-endian
            p:    struct.params.p.getUint32(0, false), // big-endian
        };

        return params;
    }


    /**
     * Calculate scrypt parameters from maxtime, maxmem, maxmemfrac values.
     *
     * Adapted from Colin Percival's code: see github.com/Tarsnap/scrypt/tree/master/lib.
     *
     * Returned parameters may vary depending on computer specs & current loading.
     *
     * @param   {number}          maxtime - maximum time in seconds scrypt will spend computing the derived key.
     * @param   {number=availMem} maxmem - maximum bytes of RAM used when computing the derived encryption key.
     * @param   {number=0.5}      maxmemfrac - fraction of the available RAM used when computing the derived key.
     * @returns {Object} Scrypt parameters logN, r, p.
     *
     * @example
     *   const params = pickParams(0.1); // => e.g. { logN: 15, r: 8, p: 1 }
     */
    static pickParams(maxtime, maxmem=os.totalmem(), maxmemfrac=0.5) {
        if (maxmem==0 || maxmem==null) maxmem = os.totalmem();
        if (maxmemfrac==0 || maxmemfrac>0.5) maxmemfrac = 0.5;

        // memory limit is memfrac · physical memory, no more than maxmem and no less than 1MiB
        const physicalMemory = os.totalmem();
        const memlimit = Math.max(Math.min(physicalMemory*maxmemfrac, maxmem), 1024*1024);

        // Colin Percival measures how many scrypts can be done in one clock tick using C/POSIX
        // clock_getres() / CLOCKS_PER_SEC (usually just one?); we will use performance.now() to get
        // a DOMHighResTimeStamp. (Following meltdown/spectre timing attacks Chrome reduced the high
        // res timestamp resolution to 100µs, so we'll be conservative and do a 1ms run - typically
        // 1..10 minimal scrypts).
        let i = 0;
        const start = performance.now();
        while (performance.now()-start < 1) {
            crypto.scryptSync('', '', 64, { N: 128, r: 1, p: 1 });
            i += 512; // we invoked the salsa20/8 core 512 times
        }
        const duration = (performance.now()-start) / 1000; // in seconds
        const opps = i / duration;

        // allow a minimum of 2^15 salsa20/8 cores
        const opslimit = Math.max(opps * maxtime, 2**15);

        const r = 8; // "fix r = 8 for now"

        // memory limit requires that 128·N·r <= memlimit
        // CPU limit requires that 4·N·r·p <= opslimit
        // if opslimit < memlimit/32, opslimit imposes the stronger limit on N

        let p = null;
        let logN = 0;
        if (opslimit < memlimit/32) {
            // set p = 1 & choose N based on CPU limit
            p = 1;
            const maxN = opslimit / (r*4);
            while (1<<logN <= maxN/2 && logN < 63) logN++;
        } else {
            // set N based on the memory limit
            const maxN = memlimit / (r * 128);
            while (1<<logN <= maxN/2 && logN < 63) logN++;
            // choose p based on the CPU limit
            const maxrp = Math.min((opslimit / 4) / (1<<logN), 0x3fffffff);
            p = Math.round(maxrp / r);
        }

        return { logN, r, p };
    }

}

/* - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -  */

module.exports = Scrypt; // ≡ export default Scrypt;