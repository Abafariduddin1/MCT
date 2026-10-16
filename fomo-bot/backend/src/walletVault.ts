import fs from 'node:fs';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {object} from './util.js';
function key(value:string):Buffer{if(!/^[a-fA-F0-9]{64}$/.test(value))throw Error('WALLET_ENCRYPTION_KEY must be 64 hexadecimal characters');return Buffer.from(value,'hex');}
export function createVault(file:string,encryptionKey:string,wallet=Keypair.generate()):string{
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(encryptionKey),iv);
  cipher.setAAD(Buffer.from('FomoBot wallet vault v1'));
  const encrypted=Buffer.concat([cipher.update(Buffer.from(wallet.secretKey)),cipher.final()]);
  const value={version:1,address:wallet.publicKey.toBase58(),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const fd=fs.openSync(file,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return value.address;
}
export function openVault(file:string,encryptionKey:string):Keypair{
  if(!fs.lstatSync(file).isFile()||fs.statSync(file).size>2048)throw Error('Invalid wallet vault file');
  const v=object(JSON.parse(fs.readFileSync(file,'utf8')));
  if(v.version!==1||typeof v.iv!=='string'||typeof v.tag!=='string'||typeof v.ciphertext!=='string'||typeof v.address!=='string')throw Error('Invalid wallet vault format');
  const iv=Buffer.from(v.iv,'base64'),tag=Buffer.from(v.tag,'base64'),ciphertext=Buffer.from(v.ciphertext,'base64');
  if(iv.length!==12||tag.length!==16||ciphertext.length!==64)throw Error('Invalid wallet vault payload');
  const decipher=createDecipheriv('aes-256-gcm',key(encryptionKey),iv);decipher.setAAD(Buffer.from('FomoBot wallet vault v1'));decipher.setAuthTag(tag);
  let bytes:Buffer;
  try{bytes=Buffer.concat([decipher.update(ciphertext),decipher.final()]);}catch{throw Error('Wallet vault authentication failed');}
  try{const wallet=Keypair.fromSecretKey(Uint8Array.from(bytes));if(wallet.publicKey.toBase58()!==v.address)throw Error('Wallet vault address mismatch');return wallet;}finally{bytes.fill(0);}
}
