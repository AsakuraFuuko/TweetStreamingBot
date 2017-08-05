'use strict';
const mongodb = require('mongodb-promises');
const url = require('url');
//https://www.npmjs.com/package/pg-pool
const params = url.parse(process.env.DATABASE_URL);
const auth = params.auth.split(':');

const config = {
    user: auth[0],
    password: auth[1],
    host: params.hostname,
    port: params.port,
    database: params.pathname.split('/')[1]
};

class DataBase {
    constructor() {
        this.db = mongodb.db(`${config.user}:${config.password}@${config.host}:${config.port}`, config.database)
    }
}

module.exports = DataBase;