"""Authored seed examples, not gameplay observations. Fixed held-out phrasing."""
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
actions=json.loads((ROOT/'training/questions.json').read_text())
train={
'follow':'따라와|나 따라와|계속 나를 따라다녀|내 뒤를 따라와 줘|나랑 같이 이동하자|내가 가는 곳으로 따라와|내 뒤에서 따라다녀 줘|나를 계속 쫓아와|라야 나 따라다녀|뒤따라와 줄래|내 옆에서 같이 걸어|내 이동 경로를 따라와|나를 놓치지 말고 따라와|지금부터 나를 따라다녀|같이 가자 내 뒤로 와|내 뒤를 졸졸 따라와|Follow me|Keep following me|Stay with me as I move|Walk behind me continuously',
'come':'이리 와|여기로 와|내 위치로 와 줘|나 있는 데로 와|지금 내 앞으로 와|여기까지 이동해 줘|나한테 와 줘|내 곁으로 와|내가 있는 곳에 도착해 줘|여기로 한번 와봐|내 위치까지 이동|이쪽으로 와 줄래|내 앞으로 이동해|나 있는 자리로 와줘|여기 와서 서 있어|나한테 오면 멈춰|Come here|Come to my location|Move to me once|Come over to where I am',
'wood':'나무 캐 줘|목재 모아 줘|나무 좀 구해 와|원목 수집해|벌목해 줘|나무를 베어 줘|통나무 모아|나무 캐자|나무가 필요해 캐 와|근처 나무를 캐 줘|원목을 확보해 줘|나무 좀 모아 줄래|목재가 모자라니 나무를 캐|주변 나무 벌목해|나무 여덟 개 모아 줘|참나무 원목 구해 줘|Gather wood logs|Chop some trees|Collect wood|Get me some logs',
'wooden_pickaxe':'나무곡괭이 만들어|나무 곡괭이 제작해 줘|목재로 곡괭이 만들어|나무로 된 곡괭이 필요해|나무 곡괭이 하나 만들어 줄래|목제 곡괭이를 제작해|나무곡 하나 만들어 봐|나무 곡괭이부터 준비해|곡괭이를 나무로 만들어 줘|돌 말고 나무 곡괭이 만들어|나무 곡괭이 새로 제작|목재 곡괭이 준비해|나무곡이 부서졌어 다시 만들어|나무 곡괭이 하나 필요하니까 제작해|나무 곡괭이를 만들어 보자|나무곡괭이 만들어 줘|Craft a wooden pickaxe|Make a wood pickaxe|I need a wooden pickaxe made|Build a wooden pickaxe',
'stone_pickaxe':'돌곡괭이 만들어|돌 곡괭이 제작해 줘|돌로 곡괭이 만들어|돌 곡괭이 하나 필요해|돌곡 만들어 줘|조약돌로 곡괭이를 만들어|나무 말고 돌 곡괭이 제작|돌곡괭이를 준비해 줘|돌 곡괭이 하나 만들어 볼래|돌로 된 곡괭이를 제작해|돌곡이 부서졌으니 새로 만들어|곡괭이 재료는 돌로 해|돌 곡괭이 새로 제작해|돌곡부터 만들어 보자|돌 곡괭이를 확보해 줘|돌 곡괭이 좀 만들어 줘|Craft a stone pickaxe|Make a pickaxe from cobblestone|I need a stone pickaxe made|Build a stone pickaxe',
'iron_pickaxe':'철곡괭이 만들어|철 곡괭이 제작해 줘|철로 곡괭이 만들어|철곡 하나 만들어 줘|철 곡괭이 준비해|철 곡괭이가 필요해 제작해|철로 된 곡괭이를 만들어|돌 말고 철 곡괭이 제작|곡괭이를 철로 만들어 줘|철곡괭이를 만들어 보자|철 곡괭이 하나 부탁해|철 곡괭이 새로 만들어|철곡이 부서졌어 다시 만들어|철 곡괭이까지 만들어 줘|철 곡괭이를 확보해 줘|철곡괭이 만들어 줘|Craft an iron pickaxe|Make a pickaxe out of iron|I need an iron pickaxe made|Build an iron pickaxe',
'status':'상태 알려줘|인벤토리 보여줘|체력 얼마나 남았어|지금 가진 아이템 알려줘|소지품 확인해 줘|뭐 갖고 있어|현재 상태 보고해|배고픔은 어느 정도야|인벤 확인|가방에 뭐 있어|남은 체력을 알려줘|아이템 목록 보여줘|현재 소지품 보고|너 상태 어때|지금 인벤토리 확인해 줘|체력과 음식 상태 알려줘|Show inventory|Report your status|How much health do you have|What items are you carrying',
'stop':'멈춰|중지|그만|작업 중단해|지금 하는 일 멈춰|아무것도 하지 마|채굴 그만해|따라오지 마|움직이지 마|나무 캐지 마|곡괭이 만들지 마|철곡괭이 만들지 말고 멈춰|작업 취소|일단 대기해|모든 행동 중지|그 자리에 가만히 있어|Stop|Cancel the current task|Stop following me|Do not craft anything',
'unknown':'안녕|오늘 날씨 좋다|너 이름이 뭐야|고마워|잘했어|다이아몬드 검 만들어|집 지어 줘|엔더드래곤 잡아|침대 만들어 줘|횃불 설치해|노래 불러 줘|나무 곡괭이는 약하네|철 곡괭이 만드는 법 알려줘|돌 곡괭이보다 철이 좋지|나무가 예쁘다|나는 지금 철곡괭이를 만들고 있어|Hello|Build a house|Tell me a story|Craft a diamond sword'
}
test={
'follow':'내가 움직일 테니 뒤에서 쫓아와 줘|이동할 때 내 뒤에 붙어서 와|어디로 가든 나를 따라다녀 줬으면 해|길 안내할게 뒤따라오렴|Keep up with me wherever I go|계속 내 뒤를 따라 이동해',
'come':'내가 서 있는 자리까지 오렴|나 있는 쪽으로 한번 이동해 줄래|내 앞까지 와서 기다려|이 자리로 와 줬으면 해|Join me at my current position then wait|일단 내 쪽으로 와 봐',
'wood':'주변에서 통나무를 좀 모아와 줄래|벌목해서 원목을 마련해 줘|목재가 없으니 나무부터 구하자|나무줄기를 캐서 가져와|Harvest logs from nearby trees|건축용 원목을 수집해 줬으면 해',
'wooden_pickaxe':'가장 먼저 목재 곡괭이 한 자루 제작해|나무 재질의 곡괭이를 마련해 줘|나무곡을 새로 하나 뽑아 줘|곡괭이 한 개를 목재로 제작하자|Please craft me a pickaxe made of wood|철곡 대신 나무곡을 만들어',
'stone_pickaxe':'조약돌 곡괭이 한 자루 제작하자|돌 재질로 곡괭이를 마련해 줘|돌곡 하나 새로 뽑아 줘|이제 돌을 재료로 곡괭이를 제작해|Please craft me a pickaxe made of stone|철곡 대신 돌곡을 만들어',
'iron_pickaxe':'철제 곡괭이 한 자루 제작하자|철 재질로 곡괭이를 마련해 줘|철곡 하나 새로 뽑아 줘|이제 철을 재료로 곡괭이를 제작해|Please craft me a pickaxe made of iron|나무곡 대신 철곡을 만들어',
'status':'지금 가방 속 내용물을 보고해|남아 있는 하트가 몇 개니|보유 중인 물건 목록이 궁금해|배는 얼마나 고프고 체력은 어때|List what you currently have in your inventory|현재 봇 상태를 확인하고 싶어',
'stop':'하던 작업은 전부 취소하고 대기해|더 이상 내 뒤를 쫓아오지 마|벌목을 당장 그만둬|철곡 만들라는 명령 취소할게|Halt all actions immediately|나무 캐는 건 하지 말고 가만히 있어',
'unknown':'오늘도 수고했네|용암이 무서워|돌 곡괭이가 뭔지 설명해 줘|철곡괭이 제작법을 설명해|Can you build a castle for me|방금 내가 나무를 캤어'
}
def write(name, examples):
 rows=[]
 for label,phrases in examples.items():
  for i,text in enumerate(phrases.split('|')):
   rows.append({'id':f'seed-v1-{name}-{label}-{i:02}','state':text,'questions':actions,'expected':{'action':label},'source':'assistant_authored_synthetic','split':name})
 assert len({r['state'] for r in rows})==len(rows)
 (ROOT/f'training/data/{name}.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in rows))
 return rows
tr=write('train',train);te=write('eval',test)
assert not {r['state'] for r in tr}&{r['state'] for r in te}
print('train',len(tr),'held-out eval',len(te))
