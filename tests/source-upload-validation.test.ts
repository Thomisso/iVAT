import { expect, inject, it } from "vitest";
import { beginUploadBatch } from "@/application/upload-batches";
import { reconcileSourceUpload } from "@/application/source-upload-transfers";
import { getSourceFile } from "@/application/source-files";
import { administratorWithCompany } from "./support/fixtures";
import { selectUploadFiles } from "./support/files";

it("refuses direct authenticated publication of asserted checksum, format and page facts", async () => {
  const owner = await administratorWithCompany();
  const selection = selectUploadFiles([{ fileName: "forged.pdf", bytes: new Uint8Array([1, 2, 3, 4]) }]);
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const file = selection.files[0];
  const identity = { companyId: owner.companyId, batchId: batch.value.id, sourceFileId: file.sourceFileId, fileName: file.fileName, byteSize: 4, sha256: selection.selectedFiles[0].sha256 };
  const state = await reconcileSourceUpload(owner.client, identity);
  if (!state.ok) throw new Error(state.error);
  const path = `${owner.companyId}/${file.sourceFileId}/${state.value.attemptId}/0/${identity.sha256}`;
  expect((await owner.client.storage.from("source-upload-chunks").upload(path, file.bytes, { contentType: "application/octet-stream" })).error).toBeNull();
  expect((await owner.client.rpc("confirm_source_upload_chunk", { target_source_file_id: file.sourceFileId, expected_attempt_id: state.value.attemptId!, chunk_offset: 0, chunk_byte_size: 4, chunk_sha256: identity.sha256 })).error).toBeNull();
  await owner.client.storage.from("source-files").upload(`${owner.companyId}/${file.sourceFileId}`, file.bytes, { contentType: "application/pdf" });
  const session = (await owner.client.auth.getSession()).data.session!;
  const url = new URL(inject("supabaseUrl"));
  const response = await fetch(new URL("/rest/v1/rpc/publish_source_upload", url), { method: "POST", headers: { apikey: inject("supabaseAnonKey"), Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({
    target_company_id: owner.companyId, target_batch_id: batch.value.id, target_source_file_id: file.sourceFileId,
    original_file_name: file.fileName, original_byte_size: 4, original_sha256: identity.sha256, expected_attempt_id: state.value.attemptId,
    source_format: "pdf", source_page_count: 1,
  }) });
  expect(response.ok).toBe(false);
  expect(await getSourceFile(owner.client, owner.companyId, file.sourceFileId)).toBeNull();
});

it("cleans a manifest item's unpublished canonical bytes after finish and deletion without a transfer row", async () => {
  const owner = await administratorWithCompany();
  const { selectFixtureFiles } = await import("./support/files");
  const { finishUploadBatch, deleteUploadBatch } = await import("@/application/upload-batches");
  const { runSourceUploadCleanupTick } = await import("@/application/source-upload-cleanup");
  const { systemClient } = await import("./support/worker");
  const selection = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  const file = selection.files[0], path = `${owner.companyId}/${file.sourceFileId}`;
  expect((await owner.client.storage.from("source-files").upload(path, file.bytes, { contentType: "image/png" })).error).toBeNull();
  expect((await finishUploadBatch(owner.client, batch.value.id)).ok).toBe(true);
  expect((await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).ok).toBe(true);
  await runSourceUploadCleanupTick(systemClient());
  expect((await systemClient().storage.from("source-files").download(path)).error).not.toBeNull();
});

it("refuses reuse of a deleted manifest identity through ordinary full-file publication", async () => {
  const owner = await administratorWithCompany();
  const { selectFixtureFiles } = await import("./support/files");
  const { finishUploadBatch, deleteUploadBatch } = await import("@/application/upload-batches");
  const { uploadSourceFile } = await import("./support/source-upload");
  const { testWorker } = await import("./support/worker");
  const selection = selectFixtureFiles("receipt.png");
  const batch = await beginUploadBatch(owner.client, { companyId: owner.companyId, fileCount: 1, selectedFiles: selection.selectedFiles });
  if (!batch.ok) throw new Error(batch.error);
  expect((await finishUploadBatch(owner.client, batch.value.id)).ok).toBe(true);
  expect((await deleteUploadBatch(owner.client, { companyId: owner.companyId, batchId: batch.value.id })).ok).toBe(true);
  expect(await uploadSourceFile(owner.client, testWorker().jobs, { companyId: owner.companyId, ...selection.files[0] })).toEqual({ ok: false, error: "forbidden" });
});

function value<T>(result: {ok:true;value:T}|{ok:false;error:string}): T { if(!result.ok) throw new Error(result.error); return result.value; }
async function readyUpload(fileName: string, bytes: Uint8Array) {
  const owner=await administratorWithCompany(); const selected=selectUploadFiles([{fileName,bytes}]);
  const batch=value(await beginUploadBatch(owner.client,{companyId:owner.companyId,fileCount:1,selectedFiles:selected.selectedFiles}));
  const identity={companyId:owner.companyId,batchId:batch.id,sourceFileId:selected.files[0].sourceFileId,fileName,byteSize:bytes.length,sha256:selected.selectedFiles[0].sha256};
  const first=value(await reconcileSourceUpload(owner.client,identity));
  const attempt={...identity,expectedAttemptId:first.attemptId};
  const {appendSourceUpload}=await import("@/application/source-upload-transfers");
  value(await appendSourceUpload(owner.client,{...attempt,offset:0,bytes}));
  const args={target_company_id:owner.companyId,target_batch_id:batch.id,target_source_file_id:identity.sourceFileId,original_file_name:fileName,original_byte_size:bytes.length,original_sha256:identity.sha256,expected_attempt_id:first.attemptId!};
  return {...owner,identity,attempt,args,bytes};
}

it("denies fabricated receipts, validates actual collision bytes, and binds proof to object identity", async () => {
 const {fixtureFile}=await import("./support/files"); const {sourceUploadValidator}=await import("./support/source-upload"); const {systemClient}=await import("./support/worker");
 const item=await readyUpload("receipt.png",fixtureFile("receipt.png"));
 const claim=await item.client.rpc("begin_source_upload_validation",item.args);if(claim.error)throw claim.error;
 expect((await item.client.rpc("record_source_upload_validation",{claim_id:claim.data,actual_sha256:item.identity.sha256,actual_byte_size:item.bytes.length,actual_format:"png",actual_page_count:1})).error?.code).toBe("42501");
 expect((await item.client.rpc("source_upload_validation_input",{claim_id:claim.data})).error?.code).toBe("42501");
 const path=`${item.companyId}/${item.identity.sourceFileId}/transfer/${item.attempt.expectedAttemptId}/original`;
 expect((await item.client.storage.from("source-files").upload(path,item.bytes,{contentType:"image/png"})).error).not.toBeNull();
 const storage=systemClient().storage.from("source-files");
 expect((await storage.upload(path,new Uint8Array(item.bytes.length),{contentType:"image/png"})).error).toBeNull();
 await expect(sourceUploadValidator().validateAndStage(claim.data)).rejects.toThrow("content mismatch");
 expect(await getSourceFile(item.client,item.companyId,item.identity.sourceFileId)).toBeNull();
 expect((await storage.remove([path])).error).toBeNull();
 value(await sourceUploadValidator().validateAndStage(claim.data));
 expect((await storage.remove([path])).error).toBeNull();
 expect((await storage.upload(path,new Uint8Array(item.bytes.length),{contentType:"image/png"})).error).toBeNull();
 expect((await item.client.rpc("publish_source_upload",{...item.args,validation_claim_id:claim.data})).error?.hint).toBe("invalid_choice");
 expect(await getSourceFile(item.client,item.companyId,item.identity.sourceFileId)).toBeNull();
});

for(const action of ["expiry","cancel","batch_delete","company_delete"] as const) it(`cleans real unpublished HEIC original and derivative after ${action}`,async()=>{
 const {heicFixture}=await import("./support/files");const {withUploadClock}=await import("./support/upload-clock");
 const {supabaseHttpGateway}=await import("./support/supabase-http-gateway");const {createClient}=await import("@supabase/supabase-js");const {asUserClient}=await import("@/application/client");
 const {completeSourceUpload,sourceUploadValidator}=await import("./support/source-upload"); const {systemClient,testWorker}=await import("./support/worker");
 const {runSourceUploadCleanupTick}=await import("@/application/source-upload-cleanup");
 await withUploadClock("2030-01-01T00:00:00.000000Z",async set=>{
  const item=await readyUpload("original.heic",heicFixture());const gateway=await supabaseHttpGateway(inject("supabaseUrl"));
  const transport=asUserClient(createClient(gateway.url,inject("supabaseAnonKey"),{auth:{persistSession:false,autoRefreshToken:false}}));
  if((await transport.auth.setSession((await item.client.auth.getSession()).data.session!)).error)throw new Error("Native session failed");
  const held=gateway.holdNext("/rest/v1/rpc/publish_source_upload");const worker=testWorker();
  const pending=completeSourceUpload(transport,worker.jobs,item.attempt,sourceUploadValidator(gateway.url));await held.started;
  const prefix=`${item.companyId}/${item.identity.sourceFileId}/transfer/${item.attempt.expectedAttemptId}`;
  try{
   expect((await systemClient().storage.from("source-files").list(prefix)).data?.map(x=>x.name).sort()).toEqual(["normalized.jpeg","original"]);
   if(action==="expiry")await set("2030-01-08T00:00:00.000000Z");
   if(action==="cancel"){const {cancelSourceUpload}=await import("@/application/source-upload-transfers");value(await cancelSourceUpload(item.client,item.attempt));}
   if(action==="batch_delete"){const {finishUploadBatch,deleteUploadBatch}=await import("@/application/upload-batches");value(await finishUploadBatch(item.client,item.identity.batchId));value(await deleteUploadBatch(item.client,{companyId:item.companyId,batchId:item.identity.batchId}));}
   if(action==="company_delete"){const {exportCompanyData,softDeleteCompany}=await import("@/application/company-deletion");const exported=value(await exportCompanyData(item.client,worker.jobs,{companyId:item.companyId}));expect(await worker.runJobs()).toEqual([]);value(await softDeleteCompany(item.client,{companyId:item.companyId,exportId:exported.exportId}));}
   await runSourceUploadCleanupTick(systemClient());
  }finally{held.release();}
  try{expect(await pending).toMatchObject({ok:false,error:action==="expiry"?"upload_expired":action==="cancel"?"upload_cancelled":"forbidden"});
   expect((await systemClient().storage.from("source-files").list(prefix)).data).toEqual([]);expect(worker.queued).toEqual([]);
  }finally{gateway.close();}
 });
});

it("rejects updating a validated immutable object through real Storage",async()=>{
 const {fixtureFile}=await import("./support/files");const {sourceUploadValidator}=await import("./support/source-upload");const {systemClient}=await import("./support/worker");
 const item=await readyUpload("receipt.png",fixtureFile("receipt.png"));const claim=await item.client.rpc("begin_source_upload_validation",item.args);if(claim.error)throw claim.error;
 value(await sourceUploadValidator().validateAndStage(claim.data));
 const path=`${item.companyId}/${item.identity.sourceFileId}/transfer/${item.attempt.expectedAttemptId}/original`;
 expect((await systemClient().storage.from("source-files").update(path,new Uint8Array(item.bytes.length),{contentType:"image/png"})).error).not.toBeNull();
});

it("rechecks receipt scope, native MFA and current page limits at publication",async()=>{
 const {fixtureFile}=await import("./support/files");const {sourceUploadValidator}=await import("./support/source-upload");
 const first=await readyUpload("two-invoices.pdf",fixtureFile("two-invoices.pdf"));const other=await readyUpload("receipt.png",fixtureFile("receipt.png"));
 const claim=await first.client.rpc("begin_source_upload_validation",first.args);if(claim.error)throw claim.error;
 value(await sourceUploadValidator().validateAndStage(claim.data));
 expect((await other.client.rpc("publish_source_upload",{...other.args,validation_claim_id:claim.data})).error?.hint).toBe("invalid_choice");
 expect((await other.client.rpc("publish_source_upload",{...first.args,validation_claim_id:claim.data})).error?.code).toBe("42501");
 const {promotedSuperAdministrator}=await import("./support/platform");const {getUploadLimits}=await import("@/application/source-files");const {setPlatformUploadLimits}=await import("@/application/platform-administration");
 const platform=await promotedSuperAdministrator("Validation limits"),previous=await getUploadLimits(first.client);
 try{
  value(await setPlatformUploadLimits(platform.client,{...previous,maxFilePages:1}));
  expect((await first.client.rpc("publish_source_upload",{...first.args,validation_claim_id:claim.data})).error?.hint).toBe("too_many_pages");
 }finally{value(await setPlatformUploadLimits(platform.client,previous));}
 const {setOrganizationMfaRequired}=await import("@/application/mfa");
 value(await setOrganizationMfaRequired(first.client,{organizationId:first.organizationId,required:true}));
 expect((await first.client.rpc("publish_source_upload",{...first.args,validation_claim_id:claim.data})).error?.code).toBe("42501");
 expect(await getSourceFile(other.client,other.companyId,other.identity.sourceFileId)).toBeNull();
});

it("denies foreign direct reads and writes to validation and permanent identity records",async()=>{
 const {fixtureFile}=await import("./support/files");const {Client}=await import("pg");const item=await readyUpload("receipt.png",fixtureFile("receipt.png"));const foreign=await administratorWithCompany();
 const session=(await foreign.client.auth.getSession()).data.session!;const claims=JSON.parse(Buffer.from(session.access_token.split(".")[1],"base64url").toString());
 const database=new Client({connectionString:inject("databaseUrl")});await database.connect();
 try{for(const table of ["source_upload_identity","source_upload_validation"]){for(const sql of [`select * from private.${table} where source_file_id=$1`,`delete from private.${table} where source_file_id=$1`]){
  await database.query("begin");await database.query("set local role authenticated");await database.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);
  await expect(database.query(sql,[item.identity.sourceFileId])).rejects.toMatchObject({code:"42501"});await database.query("rollback");
 }}}finally{await database.end();}
});

it("collects a provider's late HEIC derivative after an empty sweep while retaining the published replacement",async()=>{
 const {heicFixture}=await import("./support/files");const {normalizedDerivative,readSourceFile,readSourceFileDerivative}=await import("@/application/source-files");
 const {systemClient,testWorker}=await import("./support/worker");const {delayedTemporaryWrite}=await import("./support/upload-lifecycle");const {runSourceUploadCleanupTick}=await import("@/application/source-upload-cleanup");
 const {cancelSourceUpload,restartSourceUpload,appendSourceUpload}=await import("@/application/source-upload-transfers");const {completeSourceUpload}=await import("./support/source-upload");
 const item=await readyUpload("original.heic",heicFixture()),system=systemClient(),worker=testWorker();
 const claim=await item.client.rpc("begin_source_upload_validation",item.args);if(claim.error)throw claim.error;
 const prefix=`${item.companyId}/${item.identity.sourceFileId}/transfer/${item.attempt.expectedAttemptId}`;
 const derivative=(await normalizedDerivative("heic",item.bytes))!;
 expect((await system.storage.from("source-files").upload(`${prefix}/original`,item.bytes,{contentType:"image/heic"})).error).toBeNull();
 await delayedTemporaryWrite(`${prefix}/normalized.jpeg`,()=>system.storage.from("source-files").upload(`${prefix}/normalized.jpeg`,derivative,{contentType:"image/jpeg"}),async finish=>{
  value(await cancelSourceUpload(item.client,item.attempt));const replacement=value(await restartSourceUpload(item.client,item.attempt));
  const next={...item.identity,expectedAttemptId:replacement.attemptId};value(await appendSourceUpload(item.client,{...next,offset:0,bytes:item.bytes}));
  value(await completeSourceUpload(item.client,worker.jobs,next));
  const retained=await readSourceFileDerivative(item.client,item.companyId,item.identity.sourceFileId);expect(retained?.bytes.length).toBeGreaterThan(0);
  await runSourceUploadCleanupTick(system);expect((await system.storage.from("source-files").list(prefix)).data).toEqual([]);
  expect((await finish()).error).toBeNull();expect((await system.storage.from("source-files").list(prefix)).data).toHaveLength(1);
  await runSourceUploadCleanupTick(system);expect((await system.storage.from("source-files").list(prefix)).data).toEqual([]);
  expect((await readSourceFile(item.client,item.companyId,item.identity.sourceFileId))?.bytes).toEqual(item.bytes);
  expect((await readSourceFileDerivative(item.client,item.companyId,item.identity.sourceFileId))?.bytes).toEqual(retained?.bytes);
  expect((await item.client.rpc("publish_source_upload",{...item.args,validation_claim_id:claim.data})).error?.hint).toBe("upload_attempt_changed");
 },"source-files");
});

it("refuses asserted ordinary Source facts for a manifest item before its first reconciliation",async()=>{
 const owner=await administratorWithCompany();const selected=selectUploadFiles([{fileName:"fake.pdf",bytes:new Uint8Array([1,2,3,4])}]);
 const batch=value(await beginUploadBatch(owner.client,{companyId:owner.companyId,fileCount:1,selectedFiles:selected.selectedFiles}));const file=selected.files[0];
 expect((await owner.client.storage.from("source-files").upload(`${owner.companyId}/${file.sourceFileId}`,file.bytes,{contentType:"application/pdf"})).error).toBeNull();
 expect((await owner.client.from("source_file").insert({id:file.sourceFileId,organization_id:owner.organizationId,company_id:owner.companyId,upload_batch_id:batch.id,file_name:file.fileName,format:"pdf",byte_size:4,sha256:selected.selectedFiles[0].sha256,page_count:1})).error?.code).toBe("42501");
 expect(await getSourceFile(owner.client,owner.companyId,file.sourceFileId)).toBeNull();
});

it("refuses attaching a reserved manifest UUID through the manual Document definer path",async()=>{
 const owner=await administratorWithCompany();const {selectFixtureFiles}=await import("./support/files");const selection=selectFixtureFiles("receipt.png");
 value(await beginUploadBatch(owner.client,{companyId:owner.companyId,fileCount:1,selectedFiles:selection.selectedFiles}));
 const {SAMPLE_EXTRACTION}=await import("@/ai/fake");const {createConfirmedManualDocument}=await import("./support/claim-eligibility");
 const manual=value(await createConfirmedManualDocument(owner.client,{companyId:owner.companyId,payload:SAMPLE_EXTRACTION}));
 const {attachDocumentSource}=await import("@/application/documents");
 expect(await attachDocumentSource(owner.client,{companyId:owner.companyId,documentId:manual.id,sourceFileId:selection.files[0].sourceFileId,fileName:"receipt.png",bytes:selection.files[0].bytes})).toEqual({ok:false,error:"forbidden"});
});

it("keeps the pinned full-file identity when changing to resumable transport",async()=>{
 const owner=await administratorWithCompany();const {selectFixtureFiles}=await import("./support/files");const selected=selectFixtureFiles("receipt.png");
 const batch=value(await beginUploadBatch(owner.client,{companyId:owner.companyId,fileCount:1,selectedFiles:selected.selectedFiles})),file=selected.files[0];
 const identity={companyId:owner.companyId,batchId:batch.id,sourceFileId:file.sourceFileId,fileName:file.fileName,byteSize:file.bytes.length,sha256:selected.selectedFiles[0].sha256};
 expect((await owner.client.rpc("begin_source_file_validation",{target_company_id:owner.companyId,target_batch_id:batch.id,target_source_file_id:file.sourceFileId,original_file_name:file.fileName,original_byte_size:file.bytes.length,original_sha256:identity.sha256})).error).toBeNull();
 expect(await reconcileSourceUpload(owner.client,{...identity,fileName:"renamed.png"})).toMatchObject({ok:false,error:"invalid_choice"});
 expect(value(await reconcileSourceUpload(owner.client,identity)).confirmedBytes).toBe(0);
});
