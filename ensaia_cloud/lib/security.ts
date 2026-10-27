import {createHash, createHmac, createCipheriv,createDecipheriv,randomBytes, scrypt as rawScrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(rawScrypt);
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
export const validUsername = (x: unknown): x is string => typeof x==='string' && /^[a-z0-9][a-z0-9_-]{2,31}$/.test(x);
export const validDeviceId = (x: unknown): x is string => typeof x==='string' && /^[a-zA-Z0-9_-]{3,48}$/.test(x);
export function equal(a: string,b: string) {return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());}
export async function passwordHash(password: string) {
  const salt=randomBytes(16).toString('hex');
  const key=await scrypt(password,salt,64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [kind,salt,key]=encoded.split(':');
  if(kind!=='scrypt'||!salt||!key) return false;
  const actual=await scrypt(password,salt,64) as Buffer;
  const expected=Buffer.from(key,'hex');
  return expected.length===actual.length&&timingSafeEqual(actual,expected);
}
export function verifyDevice(deviceId: string, secret: string) {
  let allowed: Record<string,string>;
  try {allowed=JSON.parse(process.env.DEVICE_SECRETS||'{}');} catch{return false;}
  const expected=Object.hasOwn(allowed,deviceId)?allowed[deviceId]:null;
  return typeof expected==='string'&&secret.length>=32&&secret.length<=256&&equal(expected,hash(secret));
}
export function ipKey(ip: string) {
  if(!process.env.SESSION_SECRET) throw new Error('Falta SESSION_SECRET');
  return createHmac('sha256',process.env.SESSION_SECRET).update(ip).digest('hex').slice(0,32);
}
function dataKey(){if(!process.env.SESSION_SECRET)throw new Error('Falta SESSION_SECRET');return createHash('sha256').update(process.env.SESSION_SECRET).digest();}
export function seal(value:string,context:string){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',dataKey(),iv);cipher.setAAD(Buffer.from(context));
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
export function unseal(value:string,context:string){
  const data=Buffer.from(value,'base64url');if(data.length<28)throw new Error('Registro inválido');
  const decipher=createDecipheriv('aes-256-gcm',dataKey(),data.subarray(0,12));
  decipher.setAuthTag(data.subarray(12,28));decipher.setAAD(Buffer.from(context));
  return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');
}
