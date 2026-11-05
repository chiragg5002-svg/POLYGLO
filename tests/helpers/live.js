/* liveTest(["pg","redis"]) -> test() when all services are up, else test.skip(). */
const FLAGS = JSON.parse(process.env.MAESTRO_LIVE_FLAGS || "{}");
const isUp = (needs) => [].concat(needs).every((n) => FLAGS[n]);
const liveTest = (needs) => (isUp(needs) ? test : test.skip);
const liveDescribe = (needs) => (isUp(needs) ? describe : describe.skip);
module.exports = { FLAGS, isUp, liveTest, liveDescribe };
