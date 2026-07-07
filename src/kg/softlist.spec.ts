// Self-test for the software-list (hash/*.xml) extractor. Run with:
//   node src/kg/softlist.spec.ts
// The inline fixture exercises every parsing rule the real nes.xml needs:
// plain entries, clones, multi-rom dataareas, loadflag="fill"/"reload" skips,
// nodump skips, baddump keeps, hex/decimal sizes, 0x offsets, XML entities,
// vram/wram/bwram sizes, and the "!EXP" sharedfeat filter.

import { parseSoftwareList, buildCatalog } from './softlist.ts';

let totalPass = 0;
let totalFail = 0;

function eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    totalPass++;
  } else {
    totalFail++;
    console.log(`  FAIL ${label}: got ${a}, want ${e}`);
  }
}

const XML = `<?xml version="1.0"?>
<softwarelist name="nes" description="Nintendo Entertainment System cartridges">
	<software name="smb">
		<description>Super Mario Bros. (Euro, rev. A) &amp; Friends &lt;test&gt;</description>
		<year>1987</year>
		<publisher>Nintendo</publisher>
		<info name="serial" value="NES-SM"/>
		<part name="cart" interface="nes_cart">
			<feature name="slot" value="nrom" />
			<feature name="pcb" value="NES-NROM-256" />
			<feature name="mirroring" value="vertical" />
			<dataarea name="prg" size="32768">
				<rom name="pal-sm-0 prg" size="32768" crc="967A605F" sha1="deadbeef" offset="00000" status="baddump" />
			</dataarea>
			<dataarea name="chr" size="8192">
				<rom name="hvc-sm-0 chr" size="8192" crc="867b51ad" sha1="cafe" offset="00000" />
			</dataarea>
		</part>
	</software>
	<software name="smb1" cloneof="smb">
		<description>Super Mario Bros. (World)</description>
		<year>1985</year>
		<publisher>Nintendo</publisher>
		<part name="cart" interface="nes_cart">
			<feature name="slot" value="nrom" />
			<dataarea name="prg" size="0x8000">
				<rom name="a" size="16384" crc="11111111" offset="0" />
				<rom name="b" size="16384" crc="22222222" offset="0x4000" />
				<rom name="fillx" size="16384" offset="0x4000" loadflag="fill" value="0xff" />
				<rom name="c" size="16384" crc="33333333" offset="4000" loadflag="reload" />
			</dataarea>
			<dataarea name="chr" size="8192">
				<rom name="nd" size="8192" offset="0" status="nodump" />
			</dataarea>
			<dataarea name="vram" size="8192" />
			<dataarea name="bwram" size="2048" />
		</part>
	</software>
	<software name="expcart">
		<description>Expansion-audio cart</description>
		<year>1990</year>
		<publisher>Konami</publisher>
		<sharedfeat name="compatibility" value="NTSC,EXP"/>
		<part name="cart" interface="nes_cart">
			<feature name="slot" value="vrc7" />
			<dataarea name="prg" size="131072">
				<rom name="p" size="131072" crc="44444444" offset="0" />
			</dataarea>
		</part>
	</software>
</softwarelist>
`;

const parsed = parseSoftwareList(XML);

eq('list name', parsed.name, 'nes');
eq('list description', parsed.description, 'Nintendo Entertainment System cartridges');
eq('part interface', parsed.interface, 'nes_cart');
eq('entry count (pre-filter)', parsed.entries.length, 3);

// entry 1: plain, entities unescaped, baddump crc kept + lowercased
{
  const e = parsed.entries[0];
  eq('smb name', e.name, 'smb');
  eq('entities unescaped', e.description, 'Super Mario Bros. (Euro, rev. A) & Friends <test>');
  eq('smb year', e.year, '1987');
  eq('smb slot', e.slot, 'nrom');
  eq('smb pcb', e.pcb, 'NES-NROM-256');
  eq('smb mirroring', e.mirroring, 'vertical');
  eq('baddump crc kept + lowercased', e.prg.roms[0].crc, '967a605f');
  eq('smb chr crc', e.chr?.roms[0].crc, '867b51ad');
}

// entry 2: clone, hex size, fill/reload skipped, hex offsets, nodump chr, ram areas
{
  const e = parsed.entries[1];
  eq('cloneof', e.cloneof, 'smb');
  eq('hex dataarea size', e.prg.size, 0x8000);
  eq('fill + reload skipped', e.prg.roms.length, 2);
  eq('bare-hex offset', e.prg.roms[1].offset, 0x4000);
  eq('nodump chr rom skipped', e.chr?.roms.length, 0);
  eq('vram size', e.vram, 8192);
  eq('bwram size', e.bwram, 2048);
  eq('wram absent', e.wram, undefined);
}

// --- catalog: filter + crc index ----------------------------------------------
{
  const cat = buildCatalog(parsed, '!EXP');
  eq('!EXP filter drops the EXP cart', cat.entries.length, 2);
  eq('filter keeps non-tagged entries', cat.entries.map(e => e.name), ['smb', 'smb1']);
  eq('compatibility field stripped from output', 'compatibility' in cat.entries[0], false);
  eq('crc index: smb', cat.crcIndex['967a605f'], [0]);
  eq('crc index: smb1 first prg rom', cat.crcIndex['11111111'], [1]);
  eq('catalog meta', [cat.list, cat.interface], ['nes', 'nes_cart']);

  const inclusive = buildCatalog(parsed, 'EXP');
  eq('bare filter keeps only tagged entries', inclusive.entries.map(e => e.name), ['expcart']);

  const unfiltered = buildCatalog(parsed);
  eq('no filter keeps everything', unfiltered.entries.length, 3);
}

console.log(`\nsoftlist.spec: ${totalPass} passed, ${totalFail} failed`);
if (totalFail > 0) process.exitCode = 1;
