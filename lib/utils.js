'use strict';
const fs = require('fs');

class Utils {
    static SaveJSON(filename, json) {
        try {
            fs.writeFileSync(filename, JSON.stringify(json))
        } catch (err) {
            console.error(err)
        }
    }

    static LoadJSON(filename) {
        try {
            return JSON.parse(fs.readFileSync(filename))
        } catch (err) {
            console.error(err);
            return null;
        }
    }
}

module.exports = Utils;