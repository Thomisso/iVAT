Bugfix

1) Celkem s DPH neodpovídá součtu základu a DPH není blokující problém. Mělo by se zobrazit jako warning, protože na dokladu může být zaokrouhlení. 
2) Schválené doklady by mělo být možné ještě upravit, protože můžou být schválené omylem. Po schválení již není možná editace, takže při erroru je to deadend.
3) Datum období nároku na odpočet by mělo být dle DUZP. Přesunout nárok na odpočet by mělo být vybráno z dropdownu, nikoli z textu. Stejně tak všechny filtry by měly být z dropdown listu, dle období. Není tedy třeba mít datum přijetí, ale pouze výběr do jakého období patří a to bude by default dle DUZP. Datum přijetí dokladu (datum importu) může být info value, ale needitovatelná. 
4) Mělo by být možné generovat nová období. Například celý rok, nebo roky. Nebo po měsících (i zpětně historicky). Momentálně se generuje pouze aktuální rok dle začátku. Co dělat, když chci další roK?
5) Formáty datumů by měly být všude dle cz standardu tedy dd / mm / rrrr. 
6) Karta na formuláři nahrání je divně zarovnaná. Vyfotit doklad se bude zobrazovat pouze na mobilu. Udělej to velmi jednoduché - pouze nahrávání souborů. 
7) Směr: Určit automaticky podle identity firmy bude design, ne feature. Nebude možné měnit při importu. 
8) Možnost smazat dávku. Pokud bude soubor v již zamčeném období, smazat to nepůjde. 
9) Zpracování v DPH je matoucí. Udělej redesign celé sekce a funcí. Flow musí být jasné a jednoduché.
10) Historie exportů nemá dobrý design. Informace se nezobrazují správně. Použité údaje podání překrývají labely.
11) Administrace zobrazuje dropdown, který jede dolu. Musí se scrollovat. Udělej jiný typ menu. 
12) Některé karty (například v nastavení) vypadají jako kdyby byly optimalizované jen na mobil. Nevyužívají screen a většina stránky je prázdná. Príklad AI konfigurace. Primární účel aplikace je použití na počítači, nikoli na mobilu (to je jen backup). Design by tomu měl být uzpůsoben.
13) Pokud api call vrací i cenu za volání, přidej to do Využití AI na platformě. Do gridu přidej i sumarizace (dle výběru) a filtry (dle výběru).
14) Pokud kliknu do detailu dávky po zpracování, je možné notifikaci označit jako přečtenou. 