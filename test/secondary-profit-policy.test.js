// Isolated policy migrations and guards. No operational database or exchange I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../lib/trading/core.js';
import {newAccount} from '../lib/trading/simulator.js';
import {enablePortfolio} from '../lib/trading/portfolio.js';
import {initializeSecondary} from '../lib/trading/secondary-futures-engine.js';
import {installExploration,EXPLORATION_VERSION} from '../lib/trading/secondary-exploration.js';
import {PROFIT_POLICY_VERSION,PROFIT_POLICY,PROFIT_ENTRY_REVISION,getProfitPolicy,installProfitPolicy,requestedProfitPolicy,makeProfitContracts,validateProfitContracts} from '../lib/trading/secondary-profit-policy.js';
const T=Date.parse('2026-11-02T02:00:00Z');
const ENV={LUMI_RUNTIME_ENV:'staging',LUMI_TRADING_MODE:'PAPER',LUMI_TRADING_STORAGE:'SQLITE',LUMI_TRADING_SECONDARY_PROFILE:EXPLORATION_VERSION,LUMI_TRADING_SECONDARY_PROFIT_POLICY:PROFIT_POLICY_VERSION};
function root(){const account=newAccount();enablePortfolio(account);const r={frequency:{account},laboratory:{status:'RESEARCH_COMPLETE',trials:[{status:'REJECTED',net:'-30'}]},research:{active:'primary',versions:{primary:{account:{cash:'100'}}}}};initializeSecondary(r,T);installExploration(r,ENV,T);return r;}
test('additive migration is explicit, idempotent and preserves protocol hashes, account and historical rejection',()=>{
 const r=root(),before=structuredClone(r),events=[];assert.equal(installProfitPolicy(r,ENV,T,e=>events.push(e)),true);const current=structuredClone(r);assert.equal(installProfitPolicy(r,ENV,T+1,e=>events.push(e)),false);assert.deepEqual(r,current);assert.equal(events.length,1);assert.equal(events[0].realTrading,false);
 delete r.secondaryExecution.profit_policy;assert.deepEqual(r,before);assert.equal(current.secondaryExecution.profit_policy.policy_hash,hash(PROFIT_POLICY));assert.equal(current.secondaryExecution.profit_policy.baseline.cash,before.frequency.account.cash);
});
test('OFF is a reversible admission policy; immutable order contracts and financial history remain untouched',()=>{
 const r=root();installProfitPolicy(r,ENV,T);const contract=makeProfitContracts(getProfitPolicy(r));r.frequency.account.pendingOrders.test={plan:{...contract,entry_revision:PROFIT_ENTRY_REVISION,holding_ms:1800000}};const before=structuredClone(r.frequency.account);
 const events=[];assert.equal(installProfitPolicy(r,{...ENV,LUMI_TRADING_SECONDARY_PROFIT_POLICY:'OFF'},T+1,e=>events.push(e)),true);assert.equal(getProfitPolicy(r),null);assert.deepEqual(r.frequency.account,before);assert.equal(validateProfitContracts(r.frequency.account.pendingOrders.test.plan),true);assert.equal(installProfitPolicy(r,{...ENV,LUMI_TRADING_SECONDARY_PROFIT_POLICY:'OFF'},T+2),false);assert.equal(events.length,1);assert.equal(installProfitPolicy(r,ENV,T+3),true);assert.deepEqual(r.frequency.account,before);assert.equal(r.secondaryExecution.profit_policy.history.length,3);
});
test('parameter changes produce a distinct persistent hash and audit history while old contracts keep their parameters',()=>{
 const r=root();installProfitPolicy(r,ENV,T);const old=makeProfitContracts(getProfitPolicy(r)),original=structuredClone(old),hashBefore=r.secondaryExecution.profit_policy.policy_hash;
 installProfitPolicy(r,{...ENV,LUMI_TRADING_SECONDARY_MIN_EXPECTED_NET_TARGET_FRACTION:'0.003',LUMI_TRADING_SECONDARY_TRAILING_RETRACEMENT_FRACTION:'0.3',LUMI_TRADING_SECONDARY_TRAILING_EXTENSION_MS:'600000',LUMI_TRADING_SECONDARY_TRAILING_STAGNATION_MS:'300000'},T+1);
 assert.notEqual(r.secondaryExecution.profit_policy.policy_hash,hashBefore);assert.equal(getProfitPolicy(r).min_expected_net_target_fraction,'0.003');assert.deepEqual(old,original);assert.equal(old.economic_policy.min_expected_net_target_fraction,'0.002');assert.equal(r.secondaryExecution.profit_policy.history[1].previous.policy_hash,hashBefore);
});
test('LIVE, nonstaging, nonsqlite, unsupported policy and absent active flag are rejected absolutely',()=>{
 for(const override of [{LUMI_TRADING_MODE:'LIVE'},{LUMI_RUNTIME_ENV:'production'},{LUMI_TRADING_STORAGE:'SUPABASE'}])assert.throws(()=>installProfitPolicy(root(),{...ENV,...override},T),/PAPER_ONLY/);
 assert.throws(()=>installProfitPolicy(root(),{...ENV,LUMI_TRADING_SECONDARY_PROFIT_POLICY:'unknown'},T),/VERSION_UNSUPPORTED/);
 const r=root();installProfitPolicy(r,ENV,T);const without={...ENV};delete without.LUMI_TRADING_SECONDARY_PROFIT_POLICY;assert.throws(()=>installProfitPolicy(r,without,T+1),/FLAG_REQUIRED/);
});
test('profit profile cannot reactivate financial gates or replace exploration with a rejected historical trial',()=>{
 const r=root();r.secondaryExecution.exploration.active=false;assert.throws(()=>installProfitPolicy(r,ENV,T),/REQUIRES_EXPLORATION/);
 assert.equal(PROFIT_POLICY.financial_loss_limits,false);assert.equal(PROFIT_POLICY.nominal_size_and_leverage_unchanged,true);assert.equal(PROFIT_POLICY.min_expected_net_target_fraction,'0.002');assert.equal(PROFIT_POLICY.retracement_fraction,'0.25');
});
test('invalid, zero, infinite, negative and silent unbounded numeric settings are refused',()=>{
 for(const field of ['LUMI_TRADING_SECONDARY_MIN_EXPECTED_NET_TARGET_FRACTION','LUMI_TRADING_SECONDARY_TRAILING_RETRACEMENT_FRACTION'])for(const value of ['0','1','-0.1','NaN','Infinity','','true','0;bad'])assert.throws(()=>requestedProfitPolicy({...ENV,[field]:value}),/PARAMETERS_INVALID/);
 for(const field of ['LUMI_TRADING_SECONDARY_TRAILING_EXTENSION_MS','LUMI_TRADING_SECONDARY_TRAILING_STAGNATION_MS'])for(const value of ['0','-1','Infinity','1.5','86400001',''])assert.throws(()=>requestedProfitPolicy({...ENV,[field]:value}),/PARAMETERS_INVALID/);
});
test('corrupt policy or immutable position contract fails visibly, never discarding hashes to resume',()=>{
 const r=root();installProfitPolicy(r,ENV,T);r.secondaryExecution.profit_policy.policy.retracement_fraction='0.3';assert.throws(()=>installProfitPolicy(r,ENV,T+1),/INTEGRITY/);
 const plan={...makeProfitContracts(PROFIT_POLICY),entry_revision:PROFIT_ENTRY_REVISION,holding_ms:1800000};assert.equal(validateProfitContracts(plan),true);plan.exit_policy.retracement_fraction='0.5';assert.throws(()=>validateProfitContracts(plan),/INTEGRITY/);delete plan.exit_policy.hash;assert.throws(()=>validateProfitContracts(plan),/INTEGRITY/);
 assert.equal(validateProfitContracts({entry_revision:'old'}),false);
});
