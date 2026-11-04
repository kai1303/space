import nodemailer from 'nodemailer';
import type { FastifyInstance } from 'fastify';
import type { EventBus } from '@space/events';
import type { WorkspaceInvitationStore } from '@space/postgres/workspace-invitations';
import { uuid } from '@space/contracts';

export interface InvitationEmailConfig { host:string;port:number;secure:boolean;user?:string;pass?:string;from:string;publicUrl:string;encryptionKey:string }
export function invitationEmailConfig(env:NodeJS.ProcessEnv=process.env):InvitationEmailConfig|undefined {
  if(!env.SPACE_SMTP_HOST)return undefined;
  const port=Number(env.SPACE_SMTP_PORT??587),secure=env.SPACE_SMTP_SECURE==='true';
  if(!Number.isInteger(port)||port<1||port>65535||!env.SPACE_SMTP_FROM||!env.SPACE_PUBLIC_URL||!/^[a-f0-9]{64}$/i.test(env.SPACE_INVITATION_ENCRYPTION_KEY??'')) throw new Error('SMTP requires valid SPACE_SMTP_PORT, SPACE_SMTP_FROM, SPACE_PUBLIC_URL and 64-hex SPACE_INVITATION_ENCRYPTION_KEY');
  const url=new URL(env.SPACE_PUBLIC_URL);
  if(env.NODE_ENV==='production'&&url.protocol!=='https:')throw new Error('SPACE_PUBLIC_URL must use HTTPS in production');
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('SPACE_PUBLIC_URL must be an HTTP(S) origin');
  if(!!env.SPACE_SMTP_USER!==!!env.SPACE_SMTP_PASS)throw new Error('SPACE_SMTP_USER and SPACE_SMTP_PASS must be configured together');
  return {host:env.SPACE_SMTP_HOST,port,secure,user:env.SPACE_SMTP_USER,pass:env.SPACE_SMTP_PASS,from:env.SPACE_SMTP_FROM,publicUrl:url.origin,encryptionKey:env.SPACE_INVITATION_ENCRYPTION_KEY!};
}
export function createInvitationMailer(config:InvitationEmailConfig) {
  const transport=nodemailer.createTransport({host:config.host,port:config.port,secure:config.secure,requireTLS:!config.secure,
    ...(config.user?{auth:{user:config.user,pass:config.pass}}:{}),connectionTimeout:10_000,greetingTimeout:10_000,socketTimeout:20_000});
  return {
    async invitation(job:{id:string;email:string;workspace_name:string;token:string}) {
      const url=`${config.publicUrl}/chat?invite=${encodeURIComponent(job.token)}`;
      await transport.sendMail({from:config.from,to:job.email,messageId:`<space-invitation-${job.id}@${new URL(config.publicUrl).hostname}>`,subject:`Invitation to ${job.workspace_name.replace(/[\r\n]/g,' ')}`,
        text:`You have been invited to join ${job.workspace_name} on Space.\n\nSign in with this email address and accept your invitation:\n${url}\n\nIf you did not expect this invitation, you can ignore this email.`});
    },
    async verification(email:string,url:string) {
      await transport.sendMail({from:config.from,to:email,subject:'Verify your Space email address',text:`Verify your email address to continue using Space:\n${url}\n\nIf you did not request this email, you can ignore it.`});
    },
    close(){transport.close();},
  };
}
export function registerInvitationEmailDelivery(app:FastifyInstance,getEvents:()=>Promise<EventBus>,store:WorkspaceInvitationStore,mailer:ReturnType<typeof createInvitationMailer>) {
  let stop:(()=>Promise<void>)|undefined;
  app.addHook('onReady',async()=>{
    stop=await(await getEvents()).subscribe('invitation.email_requested.*',{durable:'invitation-emails',queue:'invitation-emails',maxPending:4},async message=>{
      const due=Date.parse(message.event.available_at??'');
      if(Number.isFinite(due)&&due>Date.now()){await message.retry(due-Date.now());return;}
      let id:string;
      try{id=uuid(message.event.data.email_id);}catch{await message.ack();return;}
      try{
        const job=await store.emailAttempt(id);
        if(!job){await message.ack();return;}
        // SMTP has no transactional idempotency: a crash after send may duplicate the same Message-ID.
        await mailer.invitation(job);
        await store.emailFinished(id,true);
        await message.ack();
      }catch{
        await store.emailFinished(id,false);
        await message.retry(30_000);
      }
    });
  });
  app.addHook('preClose',async()=>{await stop?.();mailer.close();});
}
