'use strict';
require('longjohn');
const debug = require('debug')('twitterstreamingbot');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const Twitter = require('twit');
const express = require('express');
const bodyParser = require('body-parser');
const https = require('https');
// const Heroku = require('heroku-client');
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
    callbackUrl: `${URL}/tweet/callback`
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

app.get('/tweet', (req, res) => {
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

app.get('/tweet/callback', async (req, res) => {
    let {tg_user_id} = req.query;
    let {tokenSecret} = await OAuthsDB.getTokenSecret(tg_user_id);
    if (tokenSecret) {
        tw.callback(req.query, tokenSecret, (_, obj) => {
            console.log(obj);
            if (!!obj && !!obj.userToken) {
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
// if (isLocal) {
//     tgbot.setWebHook(`${URL}/bot${TOKEN}`, {
//         certificate: `${__dirname}/cert.pem`,
//     });
// } else {
let _ = tgbot.setWebHook(`${URL}/bot${TOKEN}`);
// }

tgbot.getMe().then((msg) => {
    botname = '@' + msg.username;
    require('./lib/error')(tgbot, process.env.ERROR_CHANNEL);

    tgbot.getWebHookInfo().then((res) => {
        debug(JSON.stringify(res))
    });

    tgbot.onText(/\/auth/, (msg, match) => {
        let org_msg_id = msg.message_id;
        let chat_id = msg.chat.id;
        let from_id = msg.from.id;
        return tgbot.sendMessage(chat_id, `Open this URL for authorization.\n\n${URL}/tweet?tg_user_id=${from_id}`, {
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

    tgbot.onText(/\/retweeted_self/, async (msg, match) => {
        let org_msg_id = msg.message_id;
        let chat_id = msg.chat.id;
        let from_id = msg.from.id;
        let retweeted = await UsersDB.getUserSetting(from_id, 'show_self_retweeted');
        if (!!retweeted) {
            await UsersDB.setUserSetting(from_id, 'show_self_retweeted', false);
            return tgbot.sendMessage(chat_id, `disabled forward retweeted by self`, {
                reply_to_message_id: org_msg_id
            })
        } else {
            await UsersDB.setUserSetting(from_id, 'show_self_retweeted', true);
            return tgbot.sendMessage(chat_id, `enabled forward rewteeted by self`, {
                reply_to_message_id: org_msg_id
            })
        }
    });

    tgbot.onText(/\/retweeted_other/, async (msg, match) => {
        let org_msg_id = msg.message_id;
        let chat_id = msg.chat.id;
        let from_id = msg.from.id;
        let retweeted = await UsersDB.getUserSetting(from_id, 'show_other_retweeted');
        if (!!retweeted) {
            await UsersDB.setUserSetting(from_id, 'show_other_retweeted', false);
            return tgbot.sendMessage(chat_id, `disabled forward retweeted by other`, {
                reply_to_message_id: org_msg_id
            })
        } else {
            await UsersDB.setUserSetting(from_id, 'show_other_retweeted', true);
            return tgbot.sendMessage(chat_id, `enabled forward rewteeted by other`, {
                reply_to_message_id: org_msg_id
            })
        }
    });

    tgbot.onText(/\/only_pic/, async (msg, match) => {
        let org_msg_id = msg.message_id;
        let chat_id = msg.chat.id;
        let from_id = msg.from.id;
        let retweeted = await UsersDB.getUserSetting(from_id, 'show_only_pic_tweet');
        if (!!retweeted) {
            await UsersDB.setUserSetting(from_id, 'show_only_pic_tweet', false);
            return tgbot.sendMessage(chat_id, `disabled only show pic tweets`, {
                reply_to_message_id: org_msg_id
            })
        } else {
            await UsersDB.setUserSetting(from_id, 'show_only_pic_tweet', true);
            return tgbot.sendMessage(chat_id, `enabled only show pic tweets`, {
                reply_to_message_id: org_msg_id
            })
        }
    });

    tgbot.on('callback_query', async (callbackQuery) => {
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
                        let {data} = tweet;
                        if (data.errors && data.errors.length > 0) {
                            let err = data.errors;
                            console.error(err);
                            if (err[0] && err[0].code === 139) {
                                return tgbot.editMessageReplyMarkup({
                                    inline_keyboard: [
                                        [
                                            {text: '❤️ 已收藏', callback_data: `u�${args[1]}�${args[2]}`},
                                        ]
                                    ]
                                }, {
                                    chat_id: opts.chat_id,
                                    message_id: opts.msg_id
                                });
                            }
                        } else {
                            tweet = data;
                            log(`like ${tweet.id}`);
                            return tgbot.editMessageReplyMarkup({
                                inline_keyboard: [
                                    [
                                        {text: '❤️ 已收藏', callback_data: `u�${args[1]}�${args[2]}`},
                                    ]
                                ]
                            }, {
                                chat_id: opts.chat_id,
                                message_id: opts.msg_id
                            });
                        }
                    })
                }
                case 'u': {
                    return client.post('favorites/destroy', {id: args[2]}).then(async (tweet) => {
                        let {data} = tweet;
                        if (data.errors && data.errors.length > 0) {
                            let err = data.errors;
                            console.error(err);
                            if (opts.user_id === tweetFavUserId) {
                                let tweet = await TweetsDB.getTweet(args[2]);
                                if (tweet) {
                                    let {msg_ids, tweet_id} = tweet;
                                    for (let msg_id of msg_ids) {
                                        await tgbot.deleteMessage(tgChannelId, msg_id);
                                    }
                                    await TweetsDB.removeTweet(args[2]);
                                    log(`delete tweet ${tweet_id} from channel with msg (${msg_ids})`)
                                }
                            }
                            if (err[0] && err[0].code === 144) {
                                return tgbot.editMessageReplyMarkup({
                                    inline_keyboard: [
                                        [
                                            {text: '❤️ 收藏', callback_data: `l�${args[1]}�${args[2]}`},
                                        ]
                                    ]
                                }, {
                                    chat_id: opts.chat_id,
                                    message_id: opts.msg_id
                                });
                            }
                        } else {
                            tweet = data;
                            log(`unlike ${tweet.id}`);
                            return tgbot.editMessageReplyMarkup({
                                inline_keyboard: [
                                    [
                                        {text: '❤️ 收藏', callback_data: `l�${args[1]}�${args[2]}`},
                                    ]
                                ]
                            }, {
                                chat_id: opts.chat_id,
                                message_id: opts.msg_id
                            });
                        }
                    })
                }
            }
        }
    });
    _ = loop();
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
            access_token: tokens.userToken,
            access_token_secret: tokens.userTokenSecret
        };

        // if (isLocal) {
        //     twitter_options.request_options = {proxy: 'http://127.0.0.1:9090'}
        // }

        let user = tw_clients[tg_user_id];
        if (!!user) {
            let {stream} = user;
            stream.stop();
        }

        let client = new Twitter(twitter_options);

        let stream = client.stream('user', {with: 'followings', stringify_friend_ids: true});

        stream.on('tweet', async (tweet) => {
            let user_show_self_retweeted = await UsersDB.getUserSetting(tg_user_id, 'show_self_retweeted', false);
            let user_show_other_retweeted = await UsersDB.getUserSetting(tg_user_id, 'show_other_retweeted', false);
            let user_show_only_pic_tweet = await UsersDB.getUserSetting(tg_user_id, 'show_only_pic_tweet', true);

            let {
                id_str: tweet_id, user, retweeted_status: retweeted,
                in_reply_to_screen_name: is_reply, text, favorited, entities,
                extended_entities
            } = tweet;
            let {name: user_name, screen_name: user_tid} = user;
            let is_retweeted = !!retweeted;
            let show_retweetd = is_retweeted;
            if (is_retweeted) {
                if (retweeted.user.id !== user.id) {
                    show_retweetd = show_retweetd && !user_show_other_retweeted
                } else {
                    show_retweetd = show_retweetd && !user_show_self_retweeted
                }
            }
            is_reply = is_reply !== null;
            let {media: medias} = entities;
            let ext_medias = !!extended_entities && extended_entities.media;
            let pics = [], org_user_name, org_tweet_id, org_user_tid;
            log(`${user_name}(@${user_tid})\n${text}\n`);
            if (!show_retweetd && !is_reply && (!user_show_only_pic_tweet || medias)) {
                if (is_retweeted) {
                    let {id_str, user} = retweeted;
                    org_user_name = user.name;
                    org_tweet_id = id_str;
                    org_user_tid = user.screen_name;
                }
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
                        let caption = `${user_name}(#${user_tid})\nhttps://twitter.com/${user_tid}/status/${tweet_id}`;
                        if (is_retweeted) {
                            caption = `${org_user_name}(#${org_user_tid})\nhttps://twitter.com/${org_user_tid}/status/${org_tweet_id}\nRT ${user_name}(#${user_tid})`
                        }
                        options.caption = caption;
                        await tgbot.sendPhoto(tg_user_id, request(pic), options).then((msg) => msg_id = msg.message_id).catch((err) => {
                            console.error(err)
                        })
                    }
                }

                let options = {parse_mode: 'HTML'};
                if (msg_id !== -1) {
                    options.reply_to_message_id = msg_id;
                }
                if (!text.includes('https://t.co/')) {
                    options.disable_web_page_preview = true;
                }
                if (medias && medias.length > 0) {
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
                }
                await tgbot.sendMessage(tg_user_id, `${text}\n\n${user_name}(<a href="https://twitter.com/${user_tid}">@${user_tid}</a>)\n<a href="https://twitter.com/${user_tid}/status/${tweet_id}">${tweet_id}</a>`, options).catch((err) => {
                    console.error(err)
                })
            }
        });

        // capture favorite tweet
        if (tg_user_id === tweetFavUserId) {
            stream.on('favorite', async (event) => {
                let {event: event_type, target_object} = event;
                debug(JSON.stringify(target_object));
                if (event_type === 'favorite') {
                    _ = _sendTweetToChannel(target_object);
                }
            });
            stream.on('unfavorite', async (event) => {
                let {event: event_type, target_object} = event;
                debug(JSON.stringify(target_object));
                if (event_type === 'unfavorite') {
                    let {id_str} = target_object;
                    let tweet = await TweetsDB.getTweet(id_str);
                    if (tweet) {
                        let {msg_ids, tweet_id} = tweet;
                        for (let msg_id of msg_ids) {
                            await tgbot.deleteMessage(tgChannelId, msg_id).catch((err) => console.error(err));
                        }
                        await TweetsDB.removeTweet(id_str);
                        log(`delete tweet ${tweet_id} from channel with msg (${msg_ids})`)
                    } else {
                        log(`delete not found`)
                    }
                }
            })
        }

        stream.on('error', (error) => {
            console.error(error);
        });

        tw_clients[tg_user_id] = {client, stream};

        log(`add client(${tg_user_id}, ${tokens.userName}) to list`);
    } catch (err) {
        console.error(err);
    }
}

// process.on('unhandledRejection', (reason) => {
//     console.error(reason);
//     // process.exit(1);
// });

// require('heroku-self-ping')(URL, {interval: 25 * 60 * 1000});

// let herokuApiToken = process.env.HEROKU_API_TOKEN;
// let herokuAppName = process.env.HEROKU_APP_NAME;
//
// const heroku = new Heroku({token: herokuApiToken});
//
// const crontab = require('node-crontab');
// restart at 12:00 every day
// crontab.scheduleJob('0 12 * * *', () => {
//     heroku.delete(`/apps/${herokuAppName}/dynos`).then((app) => {
//         log(app)
//     });
// });

// twitter fav
let tweetFavUserId = parseInt(process.env.TG_USER_ID) || -1;
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
                let {data} = tweets;
                for (let tweet of data) {
                    last_tweet_id = await _sendTweetToChannel(tweet);
                }
                if (last_tweet_id !== -1 && data.length !== 1) {
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

async function _sendTweetToChannel(tweet) {
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
    return tweet_id;
}

// setInterval(tweetFavLoop, 60 * 60 * 1000); // 1 hours
// twitter fav
