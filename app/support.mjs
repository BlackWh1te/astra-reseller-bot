export const SUPPORT='neva_glamur67';
export const LITEBOT_URL='https://chromewebstore.google.com/detail/funpay-lite-bot/amicfiagmpbgfiiopieeemlkblfeeeip';
export const REPOSITORY='BlackWh1te/astra-reseller-bot';
export const WALLETS={api_tokens:{label:'API · миллионы токенов',unit:'млн токенов',price:'apiRubPerMillion'},api_billions:{label:'API · миллиарды токенов',unit:'млрд токенов',price:'apiRubPerMillion',factor:1000},api_usd:{label:'API · долларовый баланс',unit:'$',price:'apiRubPerDollar'},steam:{label:'Аренда Steam',unit:'$',price:'steamRubPerDollar'},smm:{label:'SMM-услуги',unit:'$',price:'smmRubPerDollar'}};
export function topupRequest({wallet,amount,reseller,pricing={}}) {
 const product=WALLETS[wallet];const value=Number(amount);
 if(!product||!Number.isFinite(value)||value<=0||value>100_000||Math.abs(value*100-Math.round(value*100))>1e-7)throw new Error('Укажите положительный объём до 100 000 с точностью до двух знаков.');
 const rate=pricing[product.price]===null?null:pricing[product.price]*(product.factor??1);
 const quoted=Number.isFinite(rate)&&rate>0?`${(Math.ceil(value*rate*100)/100).toFixed(2)} ₽ (по текущему прайсу; подтвердите сумму)`:'цену прошу уточнить';
 const identity=String(reseller?.username??'').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80);
 const id=Number.isSafeInteger(reseller?.id)?reseller.id:'не указан';
 const text=`Здравствуйте! Хочу пополнить баланс реселлера.\nКабинет: ${identity||'укажу логин'} · ID ${id}\nНаправление: ${product.label}\nОбъём: ${value} ${product.unit}\nСумма: ${quoted}\nПрошу прислать реквизиты и порядок оплаты. После проверки оплаты прошу зачислить средства на выбранный баланс.`;
 return {text,url:`https://t.me/${SUPPORT}?text=${encodeURIComponent(text)}`,wallet,amount:value};
}
