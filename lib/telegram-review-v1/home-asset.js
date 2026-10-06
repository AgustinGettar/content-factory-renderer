import {readFile} from 'node:fs/promises';
import {sha256} from './core.js';
// Exact existing, owned branding bytes. No new creative depiction or provider.
export const HOME_ASSET=Object.freeze({artifact_id:'LUMI_TELEGRAM_HOME_V1',mime:'image/png',bucket:'project-owned-assets',path:'assets/lumi-canonical-wand.png',filename:'LUMI_TELEGRAM_HOME_V1.png',size:46273,width:561,height:701,sha256:'77d1b42c07a3de6a3845ae7674bc3637b79d9d1c373959c736ed984656646b17'});
export async function loadOwnedHomeAsset(a){
 if(a.bucket!==HOME_ASSET.bucket||a.path!==HOME_ASSET.path||a.sha256!==HOME_ASSET.sha256||a.size!==HOME_ASSET.size)throw Error('owned_home_asset_binding_mismatch');
 const bytes=await readFile(new URL('../../assets/lumi-canonical-wand.png',import.meta.url));
 if(bytes.length!==a.size||sha256(bytes)!==a.sha256)throw Error('owned_home_asset_hash_mismatch');
 return bytes;
}
