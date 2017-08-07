'use strict';
const debug = require('debug')('twitterstreamingbot');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const Twitter = require('twitter');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');

const log = require('./lib/logger');
const LoginWithTwitter = require('./lib/twitteroauth');

let OAuthsDB = new (require('./lib/db/mongo/oauths'))();
let isLocal = process.env.LOCAL === 'true';
let tw_clients = {};

let TOKEN = process.env.TELEGRAM_TOKEN;
let PORT = process.env.PORT || 5000;
let URL = process.env.APP_URL;

// twitter oauth
let tw_options = {
    consumerKey: process.env.TWITTER_CONSUMER_KEY,
    consumerSecret: process.env.TWITTER_CONSUMER_SECRET,
    callbackUrl: `${URL}/twitter/callback`
};

if (isLocal) {
    tw_options.proxy = 'http://127.0.0.1:9090'
}

const tw = new LoginWithTwitter(tw_options);
// twitter oauth

// express
const app = express();

app.use(bodyParser.json());

app.post(`/bot${TOKEN}`, (req, res) => {
    tgbot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get('/twitter', (req, res) => {
    let {tg_user_id} = req.query;
    if (tg_user_id) {
        tw.login(tg_user_id, async (_, token, url) => {
            console.log(url);
            await OAuthsDB.setTokenSecret(tg_user_id, token);
            res.redirect(url);
        });
    } else {
        res.sendStatus(400)
    }
});

app.get('/twitter/callback', async (req, res) => {
    let {tg_user_id} = req.query;
    let {tokenSecret} = await OAuthsDB.getTokenSecret(tg_user_id);
    if (tokenSecret) {
        tw.callback(req.query, tokenSecret, (_, obj) => {
            console.log(obj);
            if (!!obj) {
                OAuthsDB.setUserTokens(tg_user_id, obj);
                tgbot.sendMessage(tg_user_id, `Success authorized`);
                res.send('Success authorized, close this page.');
                let _ = createStreamingClient(tg_user_id, obj);
            } else {
                res.sendStatus(401)
            }
        })
    } else {
        res.sendStatus(400)
    }
});

if (isLocal) {
    https.createServer({
        key: fs.readFileSync(`${__dirname}/private.key`),
        cert: fs.readFileSync(`${__dirname}/cert.pem`)
    }, app).listen(PORT, '0.0.0.0', null, function () {
        log(`Server listening on port ${this.address().port} in ${app.settings.env} mode`);
    });
} else {
    app.listen(PORT, () => {
        log(`Express server is listening on ${PORT}`);
    });
}
// express

// telegram
let tg_options = {};
if (isLocal) {
    tg_options.request = {proxy: 'http://127.0.0.1:9090'};
}
let botname = '@bot_name';
const tgbot = new TelegramBot(TOKEN, tg_options);
if (isLocal) {
    tgbot.setWebHook(`${URL}/bot${TOKEN}`, {
        certificate: `${__dirname}/cert.pem`,
    });
} else {
    tgbot.setWebHook(`${URL}/bot${TOKEN}`);
}

tgbot.getMe().then((msg) => {
    botname = '@' + msg.username;

    tgbot.getWebHookInfo().then((res) => {
        debug(JSON.stringify(res))
    });

    tgbot.onText(/\/auth/, (msg, match) => {
        let org_msg_id = msg.message_id;
        let chat_id = msg.chat.id;
        let from_id = msg.from.id;
        return tgbot.sendMessage(chat_id, `Open this URL for authorization.\n\n${URL}/twitter?tg_user_id=${from_id}`, {
            reply_to_message_id: org_msg_id
        })
    });

    tgbot.onText(/\/unauth/, async (msg, match) => {
        let org_msg_id = msg.message_id;
        let chat_id = msg.chat.id;
        let from_id = msg.from.id;
        let has = await OAuthsDB.getUserTokens(from_id);
        if (has) {
            await OAuthsDB.deleteOAuth(from_id);
            let user = tw_clients[from_id];
            if (!!user) {
                let {stream} = user;
                stream.destroy();
                delete tw_clients[from_id];
                log(`remove client(${from_id}) from list`);
            }
            return tgbot.sendMessage(chat_id, `Success unauthorized`, {
                reply_to_message_id: org_msg_id
            })
        } else {
            return tgbot.sendMessage(chat_id, `Maybe not authorized`, {
                reply_to_message_id: org_msg_id
            })
        }
    });
});
// telegram

async function loop() {
    let users = await OAuthsDB.getAllUserTokens();
    for (let user of users) {
        let {user_id, userTokens} = user;
        await createStreamingClient(user_id, userTokens);
    }
}

async function createStreamingClient(tg_user_id, tokens) {
    try {
        let twitter_options = {
            consumer_key: process.env.TWITTER_CONSUMER_KEY,
            consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
            access_token_key: tokens.userToken,
            access_token_secret: tokens.userTokenSecret
        };

        if (isLocal) {
            twitter_options.request_options = {proxy: 'http://127.0.0.1:9090'}
        }

        let user = tw_clients[tg_user_id];
        if (!!user) {
            let {stream} = user;
            stream.destroy();
        }

        let client = new Twitter(twitter_options);

        let stream = client.stream('user', {with: 'followings'});

        stream.on('data', async (tweet) => {
            let tweet_id = tweet.id_str;
            let user_name = tweet.user.name;
            let user_tid = tweet.user.screen_name;
            let is_retweeted = !!tweet.retweeted_status && tweet.retweeted_status.user.id !== tweet.user.id;
            let is_reply = tweet.in_reply_to_screen_name !== null;
            let text = tweet.text;
            let medias = tweet.entities.media;
            let ext_medias = !!tweet.extended_entities && tweet.extended_entities.media;
            let pics = [];
            if (!is_retweeted && !is_reply && medias) {
                log(`${user_name}(@${user_tid})\n${text}`);

                let msg_id = -1;
                if (medias && medias.length > 0) {
                    medias.filter((media) => media.type === 'photo').map((media) => pics.push(media.media_url_https));
                    if (ext_medias) {
                        pics.length = 0;
                        ext_medias.filter((media) => media.type === 'photo').map((media) => pics.push(media.media_url_https));
                    }
                    for (let pic of pics) {
                        let options = {};
                        if (msg_id !== -1) {
                            options.reply_to_message_id = msg_id;
                        }
                        await tgbot.sendPhoto(tg_user_id, pic, options).then((msg) => msg_id = msg.message_id);
                    }
                }

                let options = {parse_mode: 'HTML'};
                if (msg_id !== -1) {
                    options.reply_to_message_id = msg_id;
                }
                if (!text.includes('https://t.co/') || (text.includes('https://t.co/') && pics.length === 1)) {
                    options.disable_web_page_preview = true;
                }
                await tgbot.sendMessage(tg_user_id, `${text}\n\n${user_name}(<a href="https://twitter.com/${user_tid}">@${user_tid}</a>)\n<a href="http://twitter.com/${user_tid}/status/${tweet_id}">${tweet_id}</a>`, options);
            }
        });

        stream.on('error', (error) => {
            console.error(error);
        });

        tw_clients[tg_user_id] = {client, stream};

        log(`add client(${tg_user_id}, ${tokens.userName}) to list`);
    } catch (err) {
        console.error(err);
    }
}

let _ = loop();

process.on('unhandledRejection', (reason) => {
    console.error(reason);
    // process.exit(1);
});

require('heroku-self-ping')(URL, {interval: 25 * 60 * 1000});
