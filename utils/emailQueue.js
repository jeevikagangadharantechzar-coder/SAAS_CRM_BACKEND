import Redis from "ioredis";

const redis = new Redis();

export const addEmailToQueue = async (emailData) => {
  await redis.lpush("email_queue", JSON.stringify(emailData));
};

export const getEmailFromQueue = async () => {
  const data = await redis.rpop("email_queue");
  return data ? JSON.parse(data) : null;
};