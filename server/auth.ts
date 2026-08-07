import cookie from "@fastify/cookie";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { pool } from "./db";

const scrypt = promisify(scryptCallback);
const credentials = z.object({ username: z.string().min(3).max(64).regex(/^[\w.-]+$/), password: z.string().min(12).max(256) });
const cookieName = "flowmetrics_session";

async function passwordHash(password: string) {
  const salt = randomBytes(16); const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}
async function passwordMatches(password: string, encoded: string) {
  const [algorithm,saltValue,keyValue] = encoded.split("$"); if (algorithm !== "scrypt" || !saltValue || !keyValue) return false;
  const expected = Buffer.from(keyValue,"base64"); const actual = await scrypt(password,Buffer.from(saltValue,"base64"),expected.length) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected,actual);
}
const tokenHash = (token:string) => createHash("sha256").update(token).digest();

export async function registerAuth(app: FastifyInstance) {
  await app.register(cookie);
  const authDisabled = process.env.AUTH_MODE === "none";
  app.post("/api/v1/auth/setup", async (request,reply) => {
    if (authDisabled) return reply.code(409).send({ error:"Authentication is disabled" });
    const existing = Number((await pool.query("SELECT count(*) FROM admin_users")).rows[0].count); if (existing) return reply.code(409).send({error:"Instance is already configured"});
    const parsed = credentials.safeParse(request.body); if (!parsed.success) return reply.code(400).send({error:"Username or password does not meet requirements"});
    const created = await pool.query<{id:string}>("INSERT INTO admin_users(username,password_hash) VALUES($1,$2) RETURNING id",[parsed.data.username,await passwordHash(parsed.data.password)]);
    return createSession(reply,created.rows[0].id);
  });
  app.post("/api/v1/auth/login", async (request,reply) => {
    if (authDisabled) return {authenticated:true,mode:"none"}; const parsed=credentials.safeParse(request.body); if(!parsed.success)return reply.code(401).send({error:"Invalid credentials"});
    const user=await pool.query<{id:string,password_hash:string}>("SELECT id,password_hash FROM admin_users WHERE username=$1",[parsed.data.username]);
    if(!user.rowCount || !(await passwordMatches(parsed.data.password,user.rows[0].password_hash)))return reply.code(401).send({error:"Invalid credentials"});
    return createSession(reply,user.rows[0].id);
  });
  app.post("/api/v1/auth/logout",async(request,reply)=>{const token=request.cookies[cookieName];if(token)await pool.query("DELETE FROM sessions WHERE token_hash=$1",[tokenHash(token)]);reply.clearCookie(cookieName,{path:"/"});return{authenticated:false};});
  app.get("/api/v1/auth/session",async request=>({authenticated:authDisabled || await validSession(request.cookies[cookieName]),mode:authDisabled?"none":"local"}));
  app.addHook("preHandler",async(request,reply)=>{
    if(authDisabled || !request.url.startsWith("/api/v1/") || request.method==="OPTIONS" || /^\/api\/v1\/(health|status|auth\/)/.test(request.url))return;
    const configured=Number((await pool.query("SELECT count(*) FROM admin_users")).rows[0].count)>0;if(!configured)return reply.code(428).send({error:"Instance setup required"});
    if(!(await validSession(request.cookies[cookieName])))return reply.code(401).send({error:"Authentication required"});
    if(!["GET","HEAD"].includes(request.method) && request.headers["x-flowmetrics-request"]!=="1")return reply.code(403).send({error:"Missing request verification header"});
  });
}

async function validSession(token?:string){if(!token)return false;const result=await pool.query("SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()",[tokenHash(token)]);return Boolean(result.rowCount);}
async function createSession(reply: FastifyReply,userId:string){const token=randomBytes(32).toString("base64url");const expires=new Date(Date.now()+7*86_400_000);await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",[tokenHash(token),userId,expires]);reply.setCookie(cookieName,token,{path:"/",httpOnly:true,sameSite:"strict",secure:process.env.COOKIE_SECURE==="true",expires});return{authenticated:true,expiresAt:expires};}
