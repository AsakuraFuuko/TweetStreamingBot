'use strict';
const debug = require('debug')('twitterstreamingbot');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const Twitter = require('twitter');
const crontab = require('node-crontab');

const Utils = require('./lib/utils');
const log = require('./lib/logger');

let isLocal = process.env.LOCAL === 'true';
debug('isLocal =', isLocal);

let TOKEN = process.env.TELEGRAM_TOKEN;
let options = {
    webHook: {
        port: process.env.PORT || 5000
    }
};

if (isLocal) {
    options.key = `${__dirname}/private.key`;  // Path to file with PEM private key
    options.cert = `${__dirname}/cert.pem`;  // Path to file with PEM certificate
    options.request = {proxy: 'http://127.0.0.1:9090'}
}

let botname = '@bot_name';
let url = process.env.APP_URL;
const tgbot = new TelegramBot(TOKEN, options);
let list = process.env.TWITTER_LIST, twitter_id = process.env.TWITTER_ID, chat_id = process.env.OWNER_ID;

if (isLocal) {
    tgbot.setWebHook(`${url}/bot${TOKEN}`, {
        certificate: `${__dirname}/cert.pem`,
    });
} else {
    tgbot.setWebHook(`${url}/bot${TOKEN}`);
}

let twitter_options = {
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
};

if (isLocal) {
    twitter_options.request_options = {proxy: 'http://127.0.0.1:9090'}
}

const client = new Twitter(twitter_options);

tgbot.getMe().then(async (msg) => {
    botname = '@' + msg.username;
    let members = Utils.LoadJSON('members.json');
    if (!members || members.length === 0) {
        members = await client.get('lists/members', {slug: list, owner_screen_name: twitter_id, count: 5000});
        if (members.users) {
            members = members.users.map((user) => user.id);
            Utils.SaveJSON('members.json', members)
        }
    }

    client.stream('statuses/filter', {follow: members.join(',')}, (stream) => {
        stream.on('data', async (tweet) => {
            let tweet_id = tweet.id_str;
            let user_name = tweet.user.name;
            let user_tid = tweet.user.screen_name;
            let retweeted_status = tweet.retweeted_status;
            let is_reply = tweet.in_reply_to_screen_name !== null;
            let text = tweet.text;
            let medias = tweet.entities.media;
            let ext_medias = !!tweet_id.extended_entities && tweet_id.extended_entities.media;
            let pics = [];
            log(`${user_name}(@${user_tid})\n${text}`);

            if (!retweeted_status && !is_reply && medias) {
                let msg_id = -1;
                if (medias && medias.length > 0) {
                    medias.filter((media) => media.type === 'photo').map((media) => pics.push(media.media_url_https));
                    if (ext_medias) {
                        ext_medias.filter((media) => media.type === 'photo').map((media) => pics.push(media.media_url_https));
                    }
                    for (let pic of pics) {
                        let options = {};
                        if (msg_id !== -1) {
                            options.reply_to_message_id = msg_id;
                        }
                        await tgbot.sendPhoto(chat_id, pic, options).then((msg) => msg_id = msg.message_id);
                    }
                }

                let options = {parse_mode: 'HTML'};
                if (msg_id !== -1) {
                    options.reply_to_message_id = msg_id;
                }
                if (!text.includes('https://t.co/') || (text.includes('https://t.co/') && pics.length === 1)) {
                    options.disable_web_page_preview = true;
                }
                await tgbot.sendMessage(chat_id, `${text}\n\n${user_name}(<a href="https://twitter.com/${user_tid}">@${user_tid}</a>)\n<a href="http://twitter.com/${user_tid}/status/${tweet_id}">${tweet_id}</a>`, options);
            }
        });

        stream.on('error', (error) => {
            console.error(error);
        });
    });
});

// reset at 00:00 every day
crontab.scheduleJob('0 0 * * *', () => {
    Utils.SaveJSON('members.json', [])
});

process.on('unhandledRejection', (reason) => {
    console.error(reason);
    //   process.exit(1);
});

require('heroku-self-ping')(url, {interval: 25 * 60 * 1000});
