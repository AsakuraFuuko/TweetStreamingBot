'use strict';
const DataBase = require('./database');

class TweetsDB extends DataBase {
    constructor() {
        super();
        this.tweetdb = this.db.collection('ts_tweets')
    }

    fetchAllTweet() {
        return this.tweetdb.find({})
    }

    getTweet(tweet_id) {
        return this.tweetdb.findOne({tweet_id})
    }

    addTweet(tweet_id, msg_ids) {
        return this.tweetdb.findAndModifyOrUpsert({tweet_id}, [['tweet_id', 1]], {tweet_id, msg_ids})
    }

    removeTweet(tweet_id) {
        return this.tweetdb.remove({tweet_id})
    }

    updateTweet(tweet_id, tweet_id2) {
        return this.tweetdb.update({tweet_id}, {tweet_id: tweet_id2})
    }

    cleanTweets() {
        return this.tweetdb.remove({})
    }

    hasTweet(tweet_id) {
        return this.tweetdb.findOne({tweet_id}).then((doc) => !!doc)
    }
}

module.exports = TweetsDB;