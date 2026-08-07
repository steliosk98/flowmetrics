import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function masterKey() {
  if (process.env.APP_ENCRYPTION_KEY) { const key=Buffer.from(process.env.APP_ENCRYPTION_KEY,"base64"); if(key.length!==32)throw new Error("APP_ENCRYPTION_KEY must decode to 32 bytes");return key; }
  const path=resolve(process.env.FLOWMETRICS_DATA_DIR??"/app/data","encryption.key");
  try { const key=Buffer.from((await readFile(path,"utf8")).trim(),"base64");if(key.length!==32)throw new Error("Invalid persisted encryption key");return key; }
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;const key=randomBytes(32);await mkdir(dirname(path),{recursive:true});await writeFile(path,key.toString("base64"),{mode:0o600});return key;}
}

export async function encryptConnectorConfig(value:unknown){const key=await masterKey();const nonce=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,nonce);const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);return Buffer.concat([Buffer.from([1]),nonce,cipher.getAuthTag(),ciphertext]);}
export async function decryptConnectorConfig(payload:Buffer){if(payload[0]!==1)throw new Error("Unsupported encrypted configuration version");const key=await masterKey();const nonce=payload.subarray(1,13);const tag=payload.subarray(13,29);const decipher=createDecipheriv("aes-256-gcm",key,nonce);decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(payload.subarray(29)),decipher.final()]).toString("utf8")) as unknown;}
