'use strict';
const DataBase = require('./database');

class OAuthsDB extends DataBase {
    constructor() {
        super();
        this.oauthdb = this.db.collection('ts_oauths')
    }

    setTokenSecret(user_id, tokenSecret) {
        return this.oauthdb.findAndModifyOrUpsert({user_id: parseInt(user_id)}, [['user_id', 1]], {tokenSecret})
    }

    getTokenSecret(user_id) {
        return this.oauthdb.findOne({user_id: parseInt(user_id)}, {fields: {tokenSecret: 1}})
    }

    setUserTokens(user_id, userTokens) {
        return this.oauthdb.findAndModifyOrUpsert({user_id: parseInt(user_id)}, [['user_id', 1]], {userTokens})
    }

    getUserTokens(user_id) {
        return this.oauthdb.findOne({user_id: parseInt(user_id)}, {fields: {userTokens: 1}})
    }

    getAllUserTokens() {
        return this.oauthdb.find({})
    }

    deleteOAuth(user_id) {
        return this.oauthdb.remove({user_id: parseInt(user_id)}, {j: true}).then((numRemoved) => numRemoved.result.ok === 1)
    }
}

module.exports = OAuthsDB;