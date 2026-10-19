"""Build engram/llms-full.txt (plain markdown) from engram/index.html so the two never drift."""
import html, re, sys
from html.parser import HTMLParser

class P(HTMLParser):
    def __init__(s):
        super().__init__(); s.out=[]; s.buf=''; s.skip=0; s.pre=False; s.row=None; s.cell=None; s.inmain=False; s.href=None
    def flush(s, prefix=''):
        t=re.sub(r'\s+',' ',s.buf).strip()
        if t: s.out.append(prefix+t)
        s.buf=''
    def handle_starttag(s,t,a):
        a=dict(a)
        if t=='main': s.inmain=True
        if not s.inmain: return
        if t in('svg','script','style','button','figcaption') : s.skip+=1
        if s.skip: return
        if t in('h2','h3','p','li','summary','details'): s.flush()
        if t=='pre': s.flush(); s.pre=True
        if t=='tr': s.row=[]
        if t in('td','th'): s.cell=''
        if t=='a': s.href=a.get('href')
        if t=='code' and not s.pre: s.emit('`')
    def handle_endtag(s,t):
        if t=='main': s.flush(); s.inmain=False
        if not s.inmain: return
        if t in('svg','script','style','button','figcaption'): s.skip-=1; return
        if s.skip: return
        if t=='h2': s.flush('\n## ')
        elif t=='h3': s.flush('\n### ')
        elif t=='summary': s.flush('\n**Q: '); s.out[-1]+='**' if s.out else ''
        elif t=='li': s.flush('- ')
        elif t=='p': s.flush('\n' if True else '')
        elif t=='pre': s.out.append('```\n'+s.buf.strip('\n')+'\n```'); s.buf=''; s.pre=False
        elif t in('td','th'): s.row.append(re.sub(r'\s+',' ',s.cell).strip()); s.cell=None
        elif t=='tr':
            s.out.append('| '+' | '.join(s.row)+' |')
            if s.row and len(s.out)>=1 and not any(x.startswith('|') for x in s.out[-2:-1]): s.out.append('|'+'---|'*len(s.row))
            s.row=None
        elif t=='a' and s.href and s.href.startswith('http'): s.emit(f' ({s.href})'); s.href=None
        elif t=='code' and not s.pre: s.emit('`')
        elif t=='div' and not s.pre: s.flush()
        if t in('span','b','a') and not s.pre: s.emit(' ')
    def emit(s,x):
        if s.cell is not None: s.cell+=x
        else: s.buf+=x
    def handle_data(s,d):
        if not s.inmain or s.skip: return
        s.emit(d)

src=open(sys.argv[1]).read()
p=P(); p.feed(src); p.flush()
body='\n'.join(p.out)
body=re.sub(r'\n{3,}','\n\n',body)
body=re.sub(r' +([,.;:)])',r'\1',body)
body=re.sub(r'  +',' ',body)
head="# Engram: full site text\n\n> Plain-text version of https://manojrakshu.github.io/engram/ for language models. Every number links to its raw data in https://github.com/ManojRakshu/engram.\n"
open(sys.argv[2],'w').write(head+'\n'+body.strip()+'\n')
