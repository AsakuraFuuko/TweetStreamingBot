'use strict';
const debug = require('debug')('twitterstreamingbot');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const Twitter = require('twitter');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
const Heroku = require('heroku-client');
const request = require('request');
const requestPromise = require('request-promise-native');
const cheerio = require('cheerio');

const log = require('./lib/logger');
const LoginWithTwitter = require('./lib/twitteroauth');

let OAuthsDB = new (require('./lib/db/mongo/oauths'))();
let UsersDB = new (require('./lib/db/mongo/users'))();
let TweetsDB = new (require('./lib/db/mongo/tweets'))();
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

    tgbot.onText(/\/retweeted/, async (msg, match) => {
        let org_msg_id = msg.message_id;
        let chat_id = msg.chat.id;
        let from_id = msg.from.id;
        let retweeted = await UsersDB.getUserSetting(from_id, 'show_retweeted');
        if (!!retweeted) {
            await UsersDB.setUserSetting(from_id, 'show_retweeted', false);
            return tgbot.sendMessage(chat_id, `disabled forward retweeted`, {
                reply_to_message_id: org_msg_id
            })
        } else {
            await UsersDB.setUserSetting(from_id, 'show_retweeted', true);
            return tgbot.sendMessage(chat_id, `enabled forward rewteeted`, {
                reply_to_message_id: org_msg_id
            })
        }
    });

    tgbot.on('callback_query', (callbackQuery) => {
        const action = callbackQuery.data;
        const msg = callbackQuery.message;
        const opts = {
            user_id: callbackQuery.from.id,
            chat_id: msg.chat.id,
            msg_id: msg.message_id,
            callback_id: callbackQuery.id,
            chat_type: msg.chat.type
        };
        if (msg.reply_to_message) {
            opts.org_msg_id = msg.reply_to_message.message_id
        }
        let args = action.split('�');
        let tw_client = tw_clients[parseInt(args[1])];
        if (!!tw_client) {
            let client = tw_client.client;
            switch (args[0]) {
                case 'l': {
                    // favorites/create
                    return client.post('favorites/create', {id: args[2]}).then((tweet) => {
                        log(`like ${tweet.id}`);
                        return tgbot.editMessageReplyMarkup({
                            inline_keyboard: [
                                [
                                    {text: '❤️ 已收藏', callback_data: `u�${args[1]}�${args[2]}`},
                                ]
                            ]
                        }, {
                            message_id: opts.msg_id
                        });
                    }).catch((err) => console.error(err))
                }
                case 'u': {
                    return client.post('favorites/destroy', {id: args[2]}).then((tweet) => {
                        log(`unlike ${tweet.id}`);
                        return tgbot.editMessageReplyMarkup({
                            inline_keyboard: [
                                [
                                    {text: '❤️ 收藏', callback_data: `l�${args[1]}�${args[2]}`},
                                ]
                            ]
                        }, {
                            message_id: opts.msg_id
                        });
                    }).catch((err) => console.error(err))
                }
            }
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
    _ = tweetFavLoop();
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
            let user_show_retweeted = await UsersDB.getUserSetting(tg_user_id, 'show_retweeted');
            let is_retweeted = !!tweet.retweeted_status &&
                (
                    tweet.retweeted_status.user.id !== tweet.user.id ||
                    (
                        tweet.retweeted_status.user.id === tweet.user.id && !user_show_retweeted
                    )
                );
            let is_reply = tweet.in_reply_to_screen_name !== null;
            let text = tweet.text;
            let favorited = is_retweeted ? tweet.retweeted_status.favorited : tweet.favorited;
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
                        await tgbot.sendPhoto(tg_user_id, request(pic), {
                            caption: `${user_name}(#${user_tid})\nhttps://twitter.com/${user_tid}/status/${tweet_id}`
                        }).then((msg) => msg_id = msg.message_id).catch((err) => {
                            console.error(err)
                        })
                    }
                }

                let options = {parse_mode: 'HTML'};
                if (msg_id !== -1) {
                    options.reply_to_message_id = msg_id;
                }
                if (!text.includes('https://t.co/') || (text.includes('https://t.co/') && pics.length === 1)) {
                    options.disable_web_page_preview = true;
                }
                let tw_id = is_retweeted ? tweet.retweeted_status.id_str : tweet.id_str;
                if (!favorited) {
                    options.reply_markup = {
                        inline_keyboard: [
                            [
                                {text: '❤️ 收藏', callback_data: `l�${tg_user_id}�${tw_id}`},
                            ]
                        ]
                    }
                } else {
                    options.reply_markup = {
                        inline_keyboard: [
                            [
                                {text: '❤️ 已收藏', callback_data: `u�${tg_user_id}�${tw_id}`},
                            ]
                        ]
                    }
                }
                await tgbot.sendMessage(tg_user_id, `${text}\n\n${user_name}(<a href="https://twitter.com/${user_tid}">@${user_tid}</a>)\n<a href="https://twitter.com/${user_tid}/status/${tweet_id}">${tweet_id}</a>`, options).catch((err) => {
                    console.error(err)
                })
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

let herokuApiToken = process.env.HEROKU_API_TOKEN;
let herokuAppName = process.env.HEROKU_APP_NAME;

const heroku = new Heroku({token: herokuApiToken});

const crontab = require('node-crontab');
// restart at 00:00 every day
crontab.scheduleJob('0 0 * * *', () => {
    heroku.delete(`/apps/${herokuAppName}/dynos`).then((app) => {
        log(app)
    });
});

// twitter fav
let tweetFavUserId = process.env.TG_USER_ID || -1;
let tgChannelId = process.env.TG_CHANNEL_ID || '';
if (!tgChannelId.startsWith('@')) {
    tgChannelId = '@' + tgChannelId;
}
let inLoop = false;
const tweetFavLoop = async function () {
    if (inLoop) return;
    let tw_client = tw_clients[tweetFavUserId];
    if (!!tw_client) {
        let client = tw_client.client;
        let request_tweets = async (client, last) => {
            let last_tweet_id = -1;
            try {
                let options = {count: 200, include_entities: true};
                if (last !== -1) {
                    options.max_id = last
                }
                let tweets = await client.get('favorites/list', options);
                for (let tweet of tweets) {
                    let tweet_id = tweet.id_str;
                    let user_name = tweet.user.name;
                    let user_tid = tweet.user.screen_name;
                    let medias = tweet.entities.media;
                    let ext_medias = !!tweet.extended_entities && tweet.extended_entities.media;
                    let pics = [];
                    let msg_ids = [];
                    let has_tweet = await TweetsDB.hasTweet(tweet_id);
                    if (!has_tweet) {
                        if (medias && medias.length > 0) {
                            log(`fetch https://twitter.com/${user_tid}/status/${tweet_id}`);
                            medias.filter((media) => media.type === 'photo').map((media) => pics.push(media.media_url_https + ':large'));
                            if (ext_medias) {
                                pics.length = 0;
                                ext_medias.filter((media) => media.type === 'photo').map((media) => pics.push(media.media_url_https + ':large'));
                            }
                        } else {
                            let body = await requestPromise(`https://twitter.com/${user_tid}/status/${tweet_id}`);
                            if (body) {
                                let $ = cheerio.load(body);
                                let photos = $('div.AdaptiveMedia-photoContainer');
                                photos.map((i) => pics.push(photos.eq(i).attr('data-image-url') + ':large'));
                            }
                        }
                        if (pics.length > 0) {
                            for (let pic of pics) {
                                await tgbot.sendPhoto(tgChannelId, request(pic), {
                                    caption: `${user_name}(#${user_tid})\nhttps://twitter.com/${user_tid}/status/${tweet_id}`
                                }).then((msg) => {
                                    msg_ids.push(msg.message_id)
                                }).catch((err) => {
                                    console.error(err)
                                })
                            }
                            await TweetsDB.addTweet(tweet_id, msg_ids)
                        } else {
                            log(`[nomedia] https://twitter.com/${user_tid}/status/${tweet_id}`);
                        }
                    } else {
                        log(`[exists] https://twitter.com/${user_tid}/status/${tweet_id}`);
                    }
                    last_tweet_id = tweet_id;
                }

                if (last_tweet_id !== -1 && tweets.length !== 1) {
                    _ = request_tweets(client, last_tweet_id);
                } else {
                    log("fetch over")
                }
            } catch (err) {
                console.log(err);
                log('fetch error stop')
            }
        };
        _ = request_tweets(client, -1);
    }
};
setInterval(tweetFavLoop, 60 * 60 * 1000); // 1 hours
// twitter fav
