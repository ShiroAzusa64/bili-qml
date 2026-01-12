const {cacheManager,fixedQueue} = require('./utils.js');

const TIMESTAMP_EXPIRE_MS = Number(process.env.TIMESTAMP_EXPIRE_MS) || 180 * 24 * 3600 * 1000; //排行榜总数据过期时间
const CACHE_EXPIRE_MS = Number(process.env.CACHE_EXPIRE_MS) || 300 * 1000; // 排行榜cache过期时间
const leaderboardTimeInterval = [12 * 3600 * 1000,24 * 3600 * 1000, 7 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000]; //排行榜相差时间

let redis=undefined;
let leaderBoardCache={
    expireTime=0,
    caches=[]
}
let bucketCache=undefined;
async function getLeaderBoardFromTime(periodMs = 24 * 3600 * 1000, limit = 30) {
    const now = Date.now();
    const minTime = now - periodMs;
    const counts = {};
    const [_, recentVotes] = await Promise.all([
        redis.zremrangebyscore('votes:recent', '-inf', now - TIMESTAMP_EXPIRE_MS - 1),
        redis.zrangebyscore('votes:recent', minTime, now)
    ]);
    for (const member of recentVotes) {
        const bvid = member.split(':')[0];  // 从 `${bvid}:${userId}` 提取
        counts[bvid] = (counts[bvid] || 0) + 1;
    }
    const sorted = Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit);
    return sorted;
}

function getLeaderBoardFromBucketIndex(inde,limit = 30){
    let maps=[];
    for(let index=inde-2;index>=0;index--){
        maps[index+1]=new Map();
        let Rank_Xmin=Math.pow(limit/(bucketCache.maplist[index+1].size() || 1),(-1/1.1)); //幂率猜测 从需要的比例反向推算(\frac{X}{X_{min}})
        let cacheSize=Math.round(limit/Rank_Xmin) || 1;
        bucketCache.maplist[index+1].forEach((value,key) {
            if(!maps[index+1].has(value)){
                maps[index+1].set(value,new fixedRing(cacheSize));
            }
            maps[index+1].get(value).push(key);
        }
        maps[index+1].keys().forEach((value) => {maps[index+1].set(value,maps[index+1].get(value).ring)});
    }
    maps[0]=new Map();
    bucketCache.maplist[0].forEach((value,key)=>{
        if(!maps[0].has(value)){
                maps[0].set(value,[]);
            }
            maps[0].get(value).push(key);
        }
    });
    let result={};
    maps.forEach((map)=>{map.forEach((value,key)=>{
        value.forEach((bvid)=>{
            result[bvid]=(result[bvid] || 0) + key;
        })
    })});
    const sorted = Object.entries(result)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit);
    return sorted;
}

async function getLeaderBoard(range) {
    switch (range) { //滑动窗口榜单 以UNIX时间戳计算
        case "realtime":
            return await getLeaderBoardFromTime(12 * 3600 * 1000); //实时榜单 过去12小时
        case "daily":
            return leaderBoardCache.caches[0];
        case "weekly":
            return leaderBoardCache.caches[1];
        case "monthly":
            return leaderBoardCache.caches[2];
    }
}

async function updateLeaderBoardCache() {
    leaderBoardCache.expireTime = Date.now() + CACHE_EXPIRE_MS;
    await cacheManager.update();
    leaderBoardCache.caches = await Promise.all([0,1,2,3].map((time) => {
        return getLeaderBoardFromBucketIndex(time);
    }));
    console.log('Leaderboard cache updated.');
}
async function initLeaderboardManager(paraRedis){
    redis=paraRedis;
    bucketCache=new cacheManager(redis,leaderboardTimeInterval);
    await bucketCache.init();
}
module.exports={
    initLeaderboardManager,
    getLeaderBoard
}
