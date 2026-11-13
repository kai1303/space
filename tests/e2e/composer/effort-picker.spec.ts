import {expect, test} from '@playwright/test';

test('Enter focuses effort, ArrowRight changes it, and Escape restores the trigger', async ({page}) => {
  await page.setViewportSize({width:375,height:700});
  await page.goto('/preview/agent-session');
  const trigger=page.getByRole('button',{name:/Select model and effort/});
  const slider=page.getByRole('slider',{name:'Reasoning effort'});
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(slider).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext','Extra High');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded','false');
  await expect(trigger).toHaveAccessibleName(/GPT-6 Astra.*Extra High/);

  const effort=trigger.getByText('Extra High',{exact:true});
  await expect(effort).toBeVisible();
  const bounds=await effort.boundingBox();
  const button=await trigger.boundingBox();
  expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(button!.x+button!.width);
  expect(await effort.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
});
