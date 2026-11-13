import {expect,test} from '@playwright/test';
test('manage queued rows while a turn runs and resume the queue after stopping',async({page})=>{
  await page.setViewportSize({width:390,height:800});
  await page.goto('/preview/agent-session');
  const editor=page.getByRole('textbox',{name:'Message agent session'});
  async function send(text:string,key='Enter'){
    await editor.fill(text);await editor.press(key);await expect(editor).toHaveText('');
  }
  await send('Review uploads');
  await send('Check mobile uploads','Control+Enter');
  await send('Test retries','Control+Enter');
  const queue=page.getByRole('list',{name:'Queued messages'}),rows=queue.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await rows.last().getByRole('button',{name:'Queued message actions'}).click();
  await page.getByRole('menuitem',{name:'Move up'}).click();
  await expect(rows.first()).toContainText('Test retries');
  await rows.first().getByRole('button',{name:'Queued message actions'}).click();
  await page.getByRole('menuitem',{name:'Edit message'}).click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Check retry progress');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await rows.first().getByRole('button',{name:'Steer',exact:true}).click();
  await expect(page.getByRole('article').filter({hasText:'Check retry progress'})).toBeVisible();
  await expect(page.getByText('Steering accepted')).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(rows).toHaveCount(1);
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  await expect(queue).toHaveCount(0);
  await expect(page.getByText('Check mobile uploads',{exact:true})).toBeVisible();
});
