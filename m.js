const SIZES=["XS","S","M","L","XL","XXL"], ST=["pending","verified","checked-in","rejected"];
const COLS=[["reg_code","code"],["player_key","text"],["created_at","date"],["full_name","text"],["phone","text"],["email","text"],["gender","select",["Male","Female","Other"]],["dupr","number"],["jersey_size","select",SIZES],["jersey_name","text"],["payment_method","select",["Online","Cash"]],["status","status",ST],["profile_pic_url","img"],["payment_screenshot_url","img"]];
let inputs=0,selects=0,options=0,nodes=0,chars=0;
for(const [k,t,opts] of COLS){nodes++; // td
 if(t==="code"||t==="date"){nodes+=2;chars+=40;}
 else if(t==="number"||t==="text"){inputs++;nodes++;chars+=110;}
 else if(t==="select"||t==="status"){selects++;nodes++;options+=opts.length;nodes+=opts.length*2;chars+=60+opts.length*30;}
 else if(t==="img"){nodes+=5;chars+=330;}
}
nodes+=1+3; chars+=430; // actions td + button + svg + path
nodes+=1; // tr
console.log({perRow:{nodes,inputs,selects,options,chars}});
for(const n of [80,150,250]) console.log(n+" rows ->",{nodes:nodes*n,formControls:(inputs+selects)*n,optionEls:options*n,htmlKB:Math.round(chars*n/1024)});
