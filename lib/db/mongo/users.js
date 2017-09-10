'use strict';
const DataBase = require('./database');

class UsersDB extends DataBase {
    constructor() {
        super();
        this.userdb = this.db.collection('ts_users')
    }

    setUserSetting(user_id, key, value) {
        return this.userdb.findAndModifyOrUpsert({user_id: parseInt(user_id), key}, [['user_id', 1]], {value})
    }

    getUserSetting(user_id, key, default_value = false) {
        return this.userdb.findOne({user_id: parseInt(user_id), key}).then((doc) => doc ? doc.value : default_value)
    }
}

module.exports = UsersDB;